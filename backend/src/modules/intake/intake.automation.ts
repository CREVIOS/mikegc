import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  IntakeAssignmentRule,
  IntakeAutomationSettings,
  IntakeAutomationUpdate,
  IntakeEmailWebhook,
  IntakeInboundSummary,
} from "@mike/contracts";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { decryptString, encryptString } from "../../lib/mcp/client";
import { configuredApiPublicUrl } from "../../lib/runtimeConfig";
import {
  failure,
  internalFailure,
  ok,
  type ServiceFailure,
  type ServiceResult,
} from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import type { IntakeScope } from "./intake.requests";
import { cleanText } from "./intake.inboundPayload";
import { SLACK_TOKEN_ERRORS, SlackApiError, slackAuthTest } from "./intake.slack";
import { namePreprocessRules, openPreprocessRule } from "./intake.preprocess";
import {
  availableIntakeModels,
  defaultPreprocessingModel,
  defaultTriageModel,
  resolveIntakeModel,
} from "./intake.triage";

type RuleRow = {
  condition: string;
  assignee_id: string;
  preprocess: boolean;
  preprocess_kind: "workflow" | "playbook" | null;
  preprocess_ref: string | null;
};

const preprocessRef = (r: RuleRow) =>
  r.preprocess_kind && r.preprocess_ref
    ? { kind: r.preprocess_kind, id: r.preprocess_ref }
    : null;

/**
 * Automated intake's settings, which an organization's owners and admins
 * manage. Secrets are encrypted at rest and never returned; the email
 * webhook's token is kept only as its SHA-256 hash and last characters.
 */

export type AutomationRow = {
  org_id: string;
  email_enabled: boolean;
  email_token_hash: string | null;
  email_token_hint: string | null;
  email_allowed_domains: string[] | null;
  slack_enabled: boolean;
  slack_webhook_id: string;
  slack_team_id: string | null;
  slack_team_name: string | null;
  slack_bot_user_id: string | null;
  slack_signing_secret_encrypted: string | null;
  slack_signing_secret_iv: string | null;
  slack_signing_secret_tag: string | null;
  slack_bot_token_encrypted: string | null;
  slack_bot_token_iv: string | null;
  slack_bot_token_tag: string | null;
  /** The models triage and preprocessing run with; neither runs without one. */
  triage_model: string | null;
  preprocessing_model: string | null;
  configured_by: string | null;
};

const COLUMNS =
  "org_id, email_enabled, email_token_hash, email_token_hint, email_allowed_domains, " +
  "slack_enabled, slack_webhook_id, slack_team_id, slack_team_name, slack_bot_user_id, " +
  "slack_signing_secret_encrypted, slack_signing_secret_iv, slack_signing_secret_tag, " +
  "slack_bot_token_encrypted, slack_bot_token_iv, slack_bot_token_tag, " +
  "triage_model, preprocessing_model, configured_by";

/** The organization's settings, or null before anyone has opened them. */
export async function loadAutomationRow(
  db: Db,
  orgId: string,
): Promise<AutomationRow | null> {
  const { data, error } = await db
    .from("intake_automation")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  return (data as AutomationRow | null) ?? null;
}

export function slackSigningSecret(row: AutomationRow): string | null {
  return decryptString(
    row.slack_signing_secret_encrypted,
    row.slack_signing_secret_iv,
    row.slack_signing_secret_tag,
  );
}

export function slackBotToken(row: AutomationRow): string | null {
  return decryptString(
    row.slack_bot_token_encrypted,
    row.slack_bot_token_iv,
    row.slack_bot_token_tag,
  );
}

/** How a webhook URL's token is found again without storing it. */
export function emailTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Where the organization's Slack app sends its events. */
export function slackEventsUrl(webhookId: string): string {
  return `${configuredApiPublicUrl()}/webhooks/intake/slack/${webhookId}`;
}

const FORBIDDEN = failure(
  "forbidden",
  "Only the organization's owners and admins can manage automated intake.",
);

async function denied(db: Db, scope: IntakeScope): Promise<ServiceFailure | null> {
  const role = await getOrgRole(scope.actorId, scope.orgId, db);
  return isOrgAdmin(role) ? null : FORBIDDEN;
}

/**
 * The settings row, made on first use so the Slack URL has its id. A new row
 * starts triage on a fast, low-cost model and preprocessing on a stronger one
 * that the admin opening it has keys for, with them as the person both run as.
 */
async function ensureRow(
  db: Db,
  scope: IntakeScope,
): Promise<ServiceResult<AutomationRow>> {
  const orgId = scope.orgId;
  try {
    const existing = await loadAutomationRow(db, orgId);
    if (existing) return ok(existing);
    const available = await availableIntakeModels(db, orgId, scope.actorId);
    const made = await db.from("intake_automation").upsert(
      {
        org_id: orgId,
        triage_model: defaultTriageModel(available),
        preprocessing_model: defaultPreprocessingModel(available),
        configured_by: scope.actorId,
      },
      { onConflict: "org_id", ignoreDuplicates: true },
    );
    if (made.error) return internalFailure(made.error);
    const row = await loadAutomationRow(db, orgId);
    return row
      ? ok(row)
      : internalFailure(new Error("Automated intake settings are missing"));
  } catch (error) {
    return internalFailure(error);
  }
}

async function present(
  db: Db,
  scope: IntakeScope,
  row: AutomationRow,
): Promise<ServiceResult<IntakeAutomationSettings>> {
  try {
    // As whoever triage runs as; before anyone has saved, the viewer, who
    // becomes that person when they save.
    const runsAs = row.configured_by ?? scope.actorId;
    const [rules, recent, triage, preprocessing, available] = await Promise.all([
      db
        .from("intake_assignment_rules")
        .select("condition, assignee_id, preprocess, preprocess_kind, preprocess_ref")
        .eq("org_id", scope.orgId)
        .order("position", { ascending: true }),
      db
        .from("intake_inbound")
        .select("id, source, status, error, request_id, created_at")
        .eq("org_id", scope.orgId)
        .order("created_at", { ascending: false })
        .limit(20),
      resolveIntakeModel(db, scope.orgId, runsAs, row.triage_model),
      resolveIntakeModel(db, scope.orgId, runsAs, row.preprocessing_model),
      availableIntakeModels(db, scope.orgId, runsAs),
    ]);
    if (rules.error) return internalFailure(rules.error);
    if (recent.error) return internalFailure(recent.error);
    const ruleRows = (rules.data ?? []) as RuleRow[];
    // Named as the viewer can see them; one they cannot open has no name.
    const named = await namePreprocessRules(
      db,
      scope.actorId,
      ruleRows.map(preprocessRef),
    );
    return ok({
      email: {
        enabled: row.email_enabled,
        configured: row.email_token_hash !== null,
        token_hint: row.email_token_hint,
        allowed_domains: row.email_allowed_domains ?? [],
      },
      slack: {
        enabled: row.slack_enabled,
        events_url: slackEventsUrl(row.slack_webhook_id),
        configured:
          row.slack_signing_secret_encrypted !== null &&
          row.slack_bot_token_encrypted !== null,
        team_id: row.slack_team_id,
        team_name: row.slack_team_name,
        bot_user_id: row.slack_bot_user_id,
      },
      models: {
        available,
        triage: row.triage_model,
        triage_available: triage !== null,
        preprocessing: row.preprocessing_model,
        preprocessing_available: preprocessing !== null,
      },
      rules: ruleRows.map((r, i) => ({
        condition: r.condition,
        assignee_id: r.assignee_id,
        preprocess: r.preprocess,
        preprocess_with: named[i] ?? null,
      })),
      recent: ((recent.data ?? []) as IntakeInboundSummary[]).map((r) => ({
        id: r.id,
        source: r.source,
        status: r.status,
        error: r.error,
        request_id: r.request_id,
        created_at: r.created_at,
      })),
    });
  } catch (error) {
    return internalFailure(error);
  }
}

export async function getIntakeAutomation(
  db: Db,
  scope: IntakeScope,
): Promise<ServiceResult<IntakeAutomationSettings>> {
  const refused = await denied(db, scope);
  if (refused) return refused;
  const row = await ensureRow(db, scope);
  if (!row.ok) return row;
  return present(db, scope, row.data);
}

const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Sender domains as "example.com": lowercased, without "@", once each. */
export function normalizeDomains(
  values: string[],
): ServiceResult<string[]> {
  const domains: string[] = [];
  for (const value of values) {
    const domain = value.trim().toLowerCase().replace(/^@+/, "").replace(/\.$/, "");
    if (!domain) continue;
    if (!DOMAIN.test(domain))
      return failure(
        "validation",
        `"${value.trim().slice(0, 60)}" isn't a domain. Enter domains like example.com.`,
      );
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > 50)
    return failure("validation", "List at most 50 sender domains.");
  return ok(domains);
}

const ENCRYPTION_UNAVAILABLE = failure(
  "unavailable",
  "Secrets can't be saved because the server's encryption secret isn't configured.",
);

function encrypted(prefix: string, value: string): Record<string, string> | null {
  try {
    const sealed = encryptString(value);
    return {
      [`${prefix}_encrypted`]: sealed.encrypted,
      [`${prefix}_iv`]: sealed.iv,
      [`${prefix}_tag`]: sealed.tag,
    };
  } catch {
    return null;
  }
}

/** Check a bot token with Slack and learn its workspace and bot user. */
async function checkBotToken(
  token: string,
): Promise<ServiceResult<{ team_id: string; team: string | null; user_id: string }>> {
  try {
    return ok(await slackAuthTest(token));
  } catch (error) {
    if (error instanceof SlackApiError && SLACK_TOKEN_ERRORS.has(error.code))
      return failure(
        "validation",
        "Slack didn't accept this bot token. Copy the Bot User OAuth Token (xoxb-…) from your Slack app's OAuth & Permissions page.",
        "slack_token_invalid",
      );
    return failure(
      "unavailable",
      "Couldn't reach Slack to check the bot token. Try again.",
    );
  }
}

/**
 * Save a change to automated intake. Everything is checked before anything
 * is written: domains, the rules' members and, when a bot token
 * is given, the token itself with Slack. The saving admin becomes the person
 * triage runs as.
 */
export async function updateIntakeAutomation(
  db: Db,
  scope: IntakeScope,
  input: IntakeAutomationUpdate,
): Promise<ServiceResult<IntakeAutomationSettings>> {
  const refused = await denied(db, scope);
  if (refused) return refused;
  const current = await ensureRow(db, scope);
  if (!current.ok) return current;
  const row = current.data;
  const patch: Record<string, unknown> = {
    configured_by: scope.actorId,
    updated_at: new Date().toISOString(),
  };

  if (input.email_allowed_domains !== undefined) {
    const domains = normalizeDomains(input.email_allowed_domains);
    if (!domains.ok) return domains;
    patch.email_allowed_domains = domains.data;
  }
  if (input.slack_signing_secret !== undefined) {
    const sealed = encrypted("slack_signing_secret", input.slack_signing_secret.trim());
    if (!sealed) return ENCRYPTION_UNAVAILABLE;
    Object.assign(patch, sealed);
  }
  if (input.email_enabled !== undefined) {
    if (input.email_enabled && !row.email_token_hash)
      return failure(
        "validation",
        "Generate the email webhook URL before turning email on.",
      );
    patch.email_enabled = input.email_enabled;
  }
  if (input.slack_enabled !== undefined) {
    const hasSecret =
      row.slack_signing_secret_encrypted !== null ||
      input.slack_signing_secret !== undefined;
    const hasToken =
      row.slack_bot_token_encrypted !== null ||
      input.slack_bot_token !== undefined;
    if (input.slack_enabled && !(hasSecret && hasToken))
      return failure(
        "validation",
        "Save the Slack app's signing secret and bot token before turning Slack on.",
      );
    patch.slack_enabled = input.slack_enabled;
  }
  // Both run as the admin saving, so a model chosen must have their key.
  const chosenModels = (["triage_model", "preprocessing_model"] as const).filter(
    (field) => input[field] !== undefined,
  );
  if (chosenModels.some((field) => input[field] !== null)) {
    let available: string[];
    try {
      available = await availableIntakeModels(db, scope.orgId, scope.actorId);
    } catch (error) {
      return internalFailure(error);
    }
    if (
      chosenModels.some(
        (field) => input[field] !== null && !available.includes(input[field]!),
      )
    )
      return failure(
        "validation",
        "Choose a model your organization has a key for.",
      );
  }
  for (const field of chosenModels) patch[field] = input[field];
  let rules: IntakeAssignmentRule[] | null = null;
  if (input.rules !== undefined) {
    rules = input.rules.map((r) => ({
      condition: cleanText(r.condition).trim(),
      assignee_id: r.assignee_id,
      preprocess: r.preprocess,
      preprocess_with: r.preprocess_with
        ? { kind: r.preprocess_with.kind, id: r.preprocess_with.id.trim() }
        : null,
    }));
    if (rules.some((r) => r.condition.length < 1 || r.condition.length > 500))
      return failure(
        "validation",
        "Give each rule a condition of 1 to 500 characters.",
      );
    if (rules.length > 100)
      return failure("validation", "Add at most 100 rules.");
    const assignees = [...new Set(rules.map((r) => r.assignee_id))];
    if (assignees.length) {
      const { data, error } = await db
        .from("org_members")
        .select("user_id")
        .eq("org_id", scope.orgId)
        .in("user_id", assignees);
      if (error) return internalFailure(error);
      const members = new Set(((data ?? []) as { user_id: string }[]).map((m) => m.user_id));
      if (assignees.some((id) => !members.has(id)))
        return failure(
          "validation",
          "Rules can only assign to members of the organization.",
        );
    }
    // A workflow or playbook newly named must open for the admin saving it,
    // as preprocessing runs as them. One already saved stays, so an admin
    // who cannot open it can still change the other rules.
    const { data: saved, error: savedError } = await db
      .from("intake_assignment_rules")
      .select("preprocess_kind, preprocess_ref")
      .eq("org_id", scope.orgId);
    if (savedError) return internalFailure(savedError);
    const known = new Set(
      ((saved ?? []) as { preprocess_kind: string | null; preprocess_ref: string | null }[])
        .filter((r) => r.preprocess_kind && r.preprocess_ref)
        .map((r) => `${r.preprocess_kind}:${r.preprocess_ref}`),
    );
    const added = new Map<string, { kind: "workflow" | "playbook"; id: string }>();
    for (const r of rules)
      if (r.preprocess_with && !known.has(`${r.preprocess_with.kind}:${r.preprocess_with.id}`))
        added.set(`${r.preprocess_with.kind}:${r.preprocess_with.id}`, r.preprocess_with);
    for (const ref of added.values()) {
      try {
        if (!(await openPreprocessRule(db, scope.actorId, ref)))
          return failure(
            "validation",
            ref.kind === "playbook"
              ? "Choose a playbook you can open."
              : "Choose an assistant workflow you can open.",
          );
      } catch (error) {
        return internalFailure(error);
      }
    }
  }
  // Checked with Slack last, once everything local is known to be valid.
  if (input.slack_bot_token !== undefined) {
    const token = input.slack_bot_token.trim();
    const identity = await checkBotToken(token);
    if (!identity.ok) return identity;
    const sealed = encrypted("slack_bot_token", token);
    if (!sealed) return ENCRYPTION_UNAVAILABLE;
    Object.assign(patch, sealed, {
      slack_team_id: identity.data.team_id,
      slack_team_name: identity.data.team,
      slack_bot_user_id: identity.data.user_id,
    });
  }

  const { error } = await db
    .from("intake_automation")
    .update(patch)
    .eq("org_id", scope.orgId);
  if (error) return internalFailure(error);
  if (rules) {
    const saved = await replaceRules(db, scope.orgId, rules);
    if (!saved.ok) return saved;
  }
  const updated = await ensureRow(db, scope);
  if (!updated.ok) return updated;
  return present(db, scope, updated.data);
}

/**
 * The organization's rules become `rules`, in order. The new rules are
 * written before the old ones go, so a failure never leaves none.
 */
async function replaceRules(
  db: Db,
  orgId: string,
  rules: IntakeAssignmentRule[],
): Promise<ServiceResult<null>> {
  const now = new Date().toISOString();
  const ids = rules.map(() => randomUUID());
  if (rules.length) {
    const { error } = await db.from("intake_assignment_rules").insert(
      rules.map((r, position) => ({
        id: ids[position],
        org_id: orgId,
        position,
        condition: r.condition,
        assignee_id: r.assignee_id,
        preprocess: r.preprocess,
        preprocess_kind: r.preprocess_with?.kind ?? null,
        preprocess_ref: r.preprocess_with?.id ?? null,
        updated_at: now,
      })),
    );
    if (error) return internalFailure(error);
  }
  let remove = db.from("intake_assignment_rules").delete().eq("org_id", orgId);
  if (ids.length) remove = remove.not("id", "in", `(${ids.join(",")})`);
  const { error } = await remove;
  if (error) return internalFailure(error);
  return ok(null);
}

/**
 * A new email webhook URL, which replaces the previous one. Its token is the
 * credential, so it is returned only now; MikeGC keeps its hash.
 */
export async function generateIntakeEmailWebhook(
  db: Db,
  scope: IntakeScope,
): Promise<ServiceResult<IntakeEmailWebhook>> {
  const refused = await denied(db, scope);
  if (refused) return refused;
  const current = await ensureRow(db, scope);
  if (!current.ok) return current;
  const token = randomBytes(32).toString("base64url");
  const hint = token.slice(-4);
  const { error } = await db
    .from("intake_automation")
    .update({
      email_token_hash: emailTokenHash(token),
      email_token_hint: hint,
      configured_by: scope.actorId,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", scope.orgId);
  if (error) return internalFailure(error);
  return ok({
    webhook_url: `${configuredApiPublicUrl()}/webhooks/intake/email/${token}`,
    token_hint: hint,
  });
}
