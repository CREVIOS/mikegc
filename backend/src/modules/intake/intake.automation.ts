import { createHash, randomBytes } from "node:crypto";
import type {
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
import { resolveTriageModel } from "./intake.triage";

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
  triage_enabled: boolean;
  default_timezone: string | null;
  configured_by: string | null;
};

const COLUMNS =
  "org_id, email_enabled, email_token_hash, email_token_hint, email_allowed_domains, " +
  "slack_enabled, slack_webhook_id, slack_team_id, slack_team_name, slack_bot_user_id, " +
  "slack_signing_secret_encrypted, slack_signing_secret_iv, slack_signing_secret_tag, " +
  "slack_bot_token_encrypted, slack_bot_token_iv, slack_bot_token_tag, " +
  "triage_enabled, default_timezone, configured_by";

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

/** The settings row, made on first use so the Slack URL has its id. */
async function ensureRow(
  db: Db,
  orgId: string,
): Promise<ServiceResult<AutomationRow>> {
  const made = await db
    .from("intake_automation")
    .upsert({ org_id: orgId }, { onConflict: "org_id", ignoreDuplicates: true });
  if (made.error) return internalFailure(made.error);
  try {
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
    const [focus, recent, model] = await Promise.all([
      db
        .from("intake_member_focus")
        .select("user_id, focus")
        .eq("org_id", scope.orgId)
        .order("updated_at", { ascending: true }),
      db
        .from("intake_inbound")
        .select("id, source, status, error, request_id, created_at")
        .eq("org_id", scope.orgId)
        .order("created_at", { ascending: false })
        .limit(20),
      // As whoever triage runs as; before anyone has saved, the viewer, who
      // becomes that person when they save.
      resolveTriageModel(db, scope.orgId, row.configured_by ?? scope.actorId),
    ]);
    if (focus.error) return internalFailure(focus.error);
    if (recent.error) return internalFailure(recent.error);
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
      triage: {
        enabled: row.triage_enabled,
        default_timezone: row.default_timezone,
        model_available: model !== null,
      },
      focus: ((focus.data ?? []) as { user_id: string; focus: string }[]).map(
        (f) => ({ user_id: f.user_id, focus: f.focus }),
      ),
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
  const row = await ensureRow(db, scope.orgId);
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

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
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
 * is written: domains, the timezone, the focus members and, when a bot token
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
  const current = await ensureRow(db, scope.orgId);
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
  if (input.default_timezone !== undefined) {
    const zone = input.default_timezone?.trim() || null;
    if (zone && !isValidTimezone(zone))
      return failure("validation", "Choose a valid timezone.");
    patch.default_timezone = zone;
  }
  if (input.triage_enabled !== undefined)
    patch.triage_enabled = input.triage_enabled;
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
  let focus: { user_id: string; focus: string }[] | null = null;
  if (input.focus !== undefined) {
    focus = input.focus.map((f) => ({
      user_id: f.user_id,
      focus: cleanText(f.focus).trim(),
    }));
    if (focus.some((f) => f.focus.length < 1 || f.focus.length > 500))
      return failure(
        "validation",
        "Describe what each member handles in 1 to 500 characters.",
      );
    if (new Set(focus.map((f) => f.user_id)).size !== focus.length)
      return failure("validation", "Give each member one focus.");
    if (focus.length) {
      const { data, error } = await db
        .from("org_members")
        .select("user_id")
        .eq("org_id", scope.orgId)
        .in(
          "user_id",
          focus.map((f) => f.user_id),
        );
      if (error) return internalFailure(error);
      const members = new Set(((data ?? []) as { user_id: string }[]).map((m) => m.user_id));
      if (focus.some((f) => !members.has(f.user_id)))
        return failure(
          "validation",
          "Focus can only be set for members of the organization.",
        );
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
  if (focus) {
    const saved = await replaceFocus(db, scope.orgId, focus);
    if (!saved.ok) return saved;
  }
  const updated = await ensureRow(db, scope.orgId);
  if (!updated.ok) return updated;
  return present(db, scope, updated.data);
}

/** Every member's focus becomes `focus`; a member left out has none. */
async function replaceFocus(
  db: Db,
  orgId: string,
  focus: { user_id: string; focus: string }[],
): Promise<ServiceResult<null>> {
  const now = new Date().toISOString();
  if (focus.length) {
    const { error } = await db.from("intake_member_focus").upsert(
      focus.map((f) => ({ org_id: orgId, ...f, updated_at: now })),
      { onConflict: "org_id,user_id" },
    );
    if (error) return internalFailure(error);
  }
  let remove = db.from("intake_member_focus").delete().eq("org_id", orgId);
  if (focus.length)
    remove = remove.not("user_id", "in", `(${focus.map((f) => f.user_id).join(",")})`);
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
  const current = await ensureRow(db, scope.orgId);
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
