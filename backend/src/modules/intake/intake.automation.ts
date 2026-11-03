import { randomBytes, createHash } from "node:crypto";
import type {
  IntakeAssignmentRule,
  IntakeAutomationSettings,
  IntakeAutomationUpdate,
  IntakeInboundSummary,
  IntakeMailboxConnection,
} from "@mike/contracts";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { configuredApiPublicUrl } from "../../lib/runtimeConfig";
import { safeError } from "../../lib/safeError";
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
import { GmailApiError, gmailProfile, gmailSendTest, gmailServiceAccount } from "./intake.gmail";
import { graphNotificationUrl, startMailboxPolling } from "./intake.mailbox";
import { MicrosoftApiError, clearMicrosoftTokens } from "./intake.microsoft";
import {
  checkGraphMailbox,
  graphDelta,
  graphSendTest,
  graphSubscribe,
  graphUnsubscribe,
  type GraphCredentials,
} from "./intake.outlook";
import {
  encryptedColumns,
  graphClientSecret,
  slackBotToken,
  slackSigningSecret,
  teamsClientSecret,
} from "./intake.secrets";
import {
  AUTOMATION_COLUMNS,
  loadAutomationRow,
  type AutomationRow,
} from "./intake.settingsRow";
import {
  SLACK_LOOP_SCOPES,
  SLACK_TOKEN_ERRORS,
  SlackApiError,
  slackAuthTest,
} from "./intake.slack";
import { checkTeamsCredentials } from "./intake.teams";
import { namePreprocessRules, openPreprocessRule } from "./intake.preprocess";
import {
  availableIntakeModels,
  defaultPreprocessingModel,
  defaultTriageModel,
  intakeModelKeys,
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
 * manage. Secrets are encrypted at rest and never returned.
 */

export { AUTOMATION_COLUMNS, loadAutomationRow, slackBotToken, slackSigningSecret };
export type { AutomationRow };

/** Where the organization's Slack app sends its events. */
export function slackEventsUrl(webhookId: string): string {
  return `${configuredApiPublicUrl()}/webhooks/intake/slack/${webhookId}`;
}

/** The Azure Bot's messaging endpoint for the organization's Teams bot. */
export function teamsEventsUrl(webhookId: string): string {
  return `${configuredApiPublicUrl()}/webhooks/intake/teams/${webhookId}`;
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

/**
 * Read the Slack token's scopes again, so the settings page can say when
 * the app needs reinstalling. Best effort: Slack being unreachable changes
 * nothing.
 */
async function refreshSlackScopes(db: Db, row: AutomationRow): Promise<AutomationRow> {
  const token = row.slack_enabled ? slackBotToken(row) : null;
  if (!token) return row;
  try {
    const identity = await slackAuthTest(token);
    if (!identity.scopes || JSON.stringify(identity.scopes) === JSON.stringify(row.slack_scopes))
      return row;
    await db
      .from("intake_automation")
      .update({ slack_scopes: identity.scopes })
      .eq("org_id", row.org_id);
    return { ...row, slack_scopes: identity.scopes };
  } catch (error) {
    console.warn("[intake-automation] Slack scopes not checked", safeError(error));
    return row;
  }
}

async function present(
  db: Db,
  scope: IntakeScope,
  row: AutomationRow,
): Promise<ServiceResult<IntakeAutomationSettings>> {
  try {
    // Whether the chosen models have keys is as whoever they run as; before
    // anyone has saved, the viewer. The models offered are the viewer's, as
    // a save checks them and then runs as the admin saving.
    const runsAs = row.configured_by ?? scope.actorId;
    const [rules, recent, runner, viewer] = await Promise.all([
      db
        .from("intake_assignment_rules")
        .select("condition, assignee_id, preprocess, preprocess_kind, preprocess_ref")
        .eq("org_id", scope.orgId)
        .order("position", { ascending: true }),
      db
        .from("intake_inbound")
        .select("id, source, kind, status, error, request_id, created_at")
        .eq("org_id", scope.orgId)
        .order("created_at", { ascending: false })
        .limit(20),
      intakeModelKeys(db, scope.orgId, runsAs),
      runsAs === scope.actorId
        ? null
        : intakeModelKeys(db, scope.orgId, scope.actorId),
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
    const gmail = gmailServiceAccount();
    return ok({
      clarify_enabled: row.clarify_enabled !== false,
      email: {
        enabled: row.email_enabled,
        provider: row.email_provider,
        mailbox: row.email_mailbox,
        allowed_domains: row.email_allowed_domains ?? [],
        from_name: row.email_from_name?.trim() || "Legal",
        graph: {
          tenant_id: row.graph_tenant_id,
          client_id: row.graph_client_id,
          secret_set: row.graph_client_secret_encrypted !== null,
        },
        notification_url: graphNotificationUrl(row.email_webhook_id),
        gmail_client_id: gmail ? gmail.client_id ?? gmail.client_email : null,
        status: {
          subscription_expires_at: row.graph_subscription_expires_at,
          last_read_at: row.email_last_read_at,
          error: row.email_error,
        },
        needs_reconnect: row.email_reconnect_notice && !row.email_provider,
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
        missing_scopes: row.slack_scopes
          ? SLACK_LOOP_SCOPES.filter((s) => !row.slack_scopes!.includes(s))
          : [],
        message_events_seen: row.slack_messages_seen_at !== null,
      },
      teams: {
        enabled: row.teams_enabled,
        events_url: teamsEventsUrl(row.teams_webhook_id),
        configured:
          !!row.teams_app_id &&
          !!row.teams_tenant_id &&
          row.teams_client_secret_encrypted !== null,
        app_id: row.teams_app_id,
        tenant_id: row.teams_tenant_id,
        files_access: row.teams_files_access,
      },
      models: {
        available: (viewer ?? runner).available,
        triage: row.triage_model,
        triage_available: runner.hasKey(row.triage_model),
        preprocessing: row.preprocessing_model,
        preprocessing_available: runner.hasKey(row.preprocessing_model),
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
        kind: r.kind ?? "request",
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
  return present(db, scope, await refreshSlackScopes(db, row.data));
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

/** Check a bot token with Slack and learn its workspace, bot user and scopes. */
async function checkBotToken(
  token: string,
): Promise<
  ServiceResult<{ team_id: string; team: string | null; user_id: string; scopes: string[] | null }>
> {
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
    const sealed = encryptedColumns("slack_signing_secret", input.slack_signing_secret.trim());
    if (!sealed) return ENCRYPTION_UNAVAILABLE;
    Object.assign(patch, sealed);
  }
  if (input.clarify_enabled !== undefined) patch.clarify_enabled = input.clarify_enabled;
  if (input.email_from_name !== undefined) {
    const name = cleanText(input.email_from_name).replace(/[\r\n<>"]/g, " ").trim();
    if (name.length < 1 || name.length > 80)
      return failure("validation", "Give the sender name 1 to 80 characters.");
    patch.email_from_name = name;
  }
  if (input.email_enabled !== undefined) {
    if (input.email_enabled && !row.email_provider)
      return failure(
        "validation",
        "Connect the intake mailbox before turning email on.",
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
  // Both run as the admin saving, so a model chosen must have their key, and
  // so must one kept when this save makes intake run as someone new.
  const chosenModels = (["triage_model", "preprocessing_model"] as const).filter(
    (field) => input[field] !== undefined,
  );
  const runnerChanges = row.configured_by !== scope.actorId;
  const checked = (["triage_model", "preprocessing_model"] as const).flatMap(
    (field) => {
      const kept = input[field] === undefined;
      const model = kept ? (runnerChanges ? row[field] : null) : input[field];
      return model ? [{ field, model, kept }] : [];
    },
  );
  if (checked.length) {
    let available: string[];
    try {
      available = await availableIntakeModels(db, scope.orgId, scope.actorId);
    } catch (error) {
      return internalFailure(error);
    }
    const missing = checked.find((c) => !available.includes(c.model));
    if (missing)
      return failure(
        "validation",
        missing.kept
          ? `${missing.field === "triage_model" ? "Triage" : "AI preprocessing"} uses a model you don't have a key for, and saving makes intake run as you. Choose another model in Model Preferences first.`
          : "Choose a model your organization has a key for.",
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
  // Teams: the IDs as given; the credentials are checked with Microsoft
  // once the app ID, tenant ID and secret are all known.
  if (input.teams_app_id !== undefined) patch.teams_app_id = input.teams_app_id.trim().toLowerCase();
  if (input.teams_tenant_id !== undefined) patch.teams_tenant_id = input.teams_tenant_id.trim().toLowerCase();
  const teamsSecret = input.teams_client_secret?.trim() ?? teamsClientSecret(row);
  const teamsApp = (patch.teams_app_id as string | undefined) ?? row.teams_app_id;
  const teamsTenant = (patch.teams_tenant_id as string | undefined) ?? row.teams_tenant_id;
  if (input.teams_client_secret !== undefined) {
    const sealed = encryptedColumns("teams_client_secret", input.teams_client_secret.trim());
    if (!sealed) return ENCRYPTION_UNAVAILABLE;
    Object.assign(patch, sealed);
  }
  if (input.teams_enabled !== undefined) {
    if (input.teams_enabled && !(teamsApp && teamsTenant && teamsSecret))
      return failure(
        "validation",
        "Save the Teams app ID, tenant ID and client secret before turning Teams on.",
      );
    patch.teams_enabled = input.teams_enabled;
  }
  const teamsChanged =
    input.teams_app_id !== undefined ||
    input.teams_tenant_id !== undefined ||
    input.teams_client_secret !== undefined;
  if (teamsChanged && teamsApp && teamsTenant && teamsSecret) {
    const checked = await checkTeamsCredentials({
      appId: teamsApp,
      tenantId: teamsTenant,
      secret: teamsSecret,
    });
    if (!checked.ok)
      return checked.refused
        ? failure(
            "validation",
            "Microsoft didn't accept these Teams credentials. Check the app ID, tenant ID and client secret.",
            "teams_credentials_invalid",
          )
        : failure("unavailable", "Couldn't reach Microsoft to check the Teams credentials. Try again.");
    patch.teams_files_access = checked.filesAccess;
  }
  // Checked with Slack last, once everything local is known to be valid.
  if (input.slack_bot_token !== undefined) {
    const token = input.slack_bot_token.trim();
    const identity = await checkBotToken(token);
    if (!identity.ok) return identity;
    const sealed = encryptedColumns("slack_bot_token", token);
    if (!sealed) return ENCRYPTION_UNAVAILABLE;
    Object.assign(patch, sealed, {
      slack_team_id: identity.data.team_id,
      slack_team_name: identity.data.team,
      slack_bot_user_id: identity.data.user_id,
      slack_scopes: identity.data.scopes,
    });
  }

  // The rules first, as the write that can be refused: a refusal then leaves
  // the settings as they were, so the page turning a switch back is true. If
  // the settings then fail, the rules saved are the ones on the page, and
  // sending them again changes nothing.
  if (rules) {
    const saved = await replaceRules(db, scope.orgId, rules);
    if (!saved.ok) return saved;
  }
  const { error } = await db
    .from("intake_automation")
    .update(patch)
    .eq("org_id", scope.orgId);
  if (error) return internalFailure(error);
  const updated = await ensureRow(db, scope);
  if (!updated.ok) return updated;
  return present(db, scope, updated.data);
}

/**
 * The organization's rules become `rules`, in order, in one transaction that
 * holds its settings row: a failure leaves the rules as they were, and two
 * saves at once take turns rather than each deleting the other's rules.
 */
async function replaceRules(
  db: Db,
  orgId: string,
  rules: IntakeAssignmentRule[],
): Promise<ServiceResult<null>> {
  const { error } = await db.rpc("intake_replace_rules", {
    p_org: orgId,
    p_rules: rules.map((r) => ({
      condition: r.condition,
      assignee_id: r.assignee_id,
      preprocess: r.preprocess,
      preprocess_kind: r.preprocess_with?.kind ?? null,
      preprocess_ref: r.preprocess_with?.id ?? null,
    })),
  });
  if (error) return internalFailure(error);
  return ok(null);
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ID = /^[A-Za-z0-9.-]{1,200}$/;

/** What a failed mailbox call means for the admin connecting it. */
function mailboxFailure(error: unknown, fallback: string): ServiceFailure {
  if ((error instanceof MicrosoftApiError || error instanceof GmailApiError) && error.permanent)
    return failure("validation", error.sentence, "intake_mailbox_refused");
  if (error instanceof MicrosoftApiError || error instanceof GmailApiError)
    return failure("unavailable", fallback);
  return internalFailure(error);
}

/**
 * Connect the organization's intake mailbox: Microsoft 365 through Graph,
 * or Google Workspace through the Gmail API. MikeGC checks it can open the
 * mailbox, records only mail that arrives from now on, starts reading it,
 * and turns email on. The sender domains start with the address's own.
 */
export async function connectIntakeMailbox(
  db: Db,
  scope: IntakeScope & { userEmail?: string | null },
  input: IntakeMailboxConnection,
): Promise<ServiceResult<IntakeAutomationSettings>> {
  const refused = await denied(db, scope);
  if (refused) return refused;
  const current = await ensureRow(db, scope);
  if (!current.ok) return current;
  const row = current.data;
  const mailbox = input.mailbox.trim().toLowerCase();
  if (!EMAIL.test(mailbox) || mailbox.length > 320)
    return failure("validation", "Enter the intake address, such as intake@example.com.");
  const patch: Record<string, unknown> = {
    email_provider: input.provider,
    email_mailbox: mailbox,
    email_enabled: true,
    email_error: null,
    email_reconnect_notice: false,
    email_last_read_at: new Date().toISOString(),
    configured_by: scope.actorId,
    updated_at: new Date().toISOString(),
  };
  const domain = mailbox.split("@").pop()!;
  if (!(row.email_allowed_domains ?? []).length) patch.email_allowed_domains = [domain];
  if (input.provider === "graph") {
    const tenantId = input.tenant_id.trim().toLowerCase();
    const clientId = input.client_id.trim().toLowerCase();
    if (!ID.test(tenantId) || !ID.test(clientId))
      return failure("validation", "Enter the Entra app's tenant ID and client ID.");
    const secret = input.client_secret?.trim() || graphClientSecret(row);
    if (!secret) return failure("validation", "Enter the Entra app's client secret.");
    if (input.client_secret) {
      const sealed = encryptedColumns("graph_client_secret", secret);
      if (!sealed) return ENCRYPTION_UNAVAILABLE;
      Object.assign(patch, sealed);
    }
    clearMicrosoftTokens();
    const credentials: GraphCredentials = { tenantId, clientId, clientSecret: secret, mailbox };
    try {
      await checkGraphMailbox(credentials);
      // Mail from now on: the first delta read starts at this moment.
      patch.graph_delta_link = (await graphDelta(credentials, null)).deltaLink;
    } catch (error) {
      return mailboxFailure(error, "Couldn't reach Microsoft to check the mailbox. Try again.");
    }
    if (row.graph_subscription_id && row.graph_tenant_id && row.graph_client_id && row.email_mailbox) {
      const old = graphClientSecret(row);
      if (old)
        await graphUnsubscribe(
          { tenantId: row.graph_tenant_id, clientId: row.graph_client_id, clientSecret: old, mailbox: row.email_mailbox },
          row.graph_subscription_id,
        );
    }
    const clientState = randomBytes(32).toString("base64url");
    try {
      const subscription = await graphSubscribe(credentials, {
        notificationUrl: graphNotificationUrl(row.email_webhook_id),
        clientState,
      });
      Object.assign(patch, {
        graph_subscription_id: subscription.id,
        graph_subscription_expires_at: subscription.expiresAt,
        graph_client_state_hash: createHash("sha256").update(clientState).digest("hex"),
      });
    } catch (error) {
      // Without notifications, the mailbox is still read every 15 minutes.
      console.warn("[intake-automation] Graph subscription not created", safeError(error));
      Object.assign(patch, {
        graph_subscription_id: null,
        graph_subscription_expires_at: null,
        email_error:
          "Microsoft couldn't reach MikeGC's notification URL, so MikeGC reads the mailbox every 15 minutes instead.",
      });
    }
    Object.assign(patch, {
      graph_tenant_id: tenantId,
      graph_client_id: clientId,
      gmail_history_id: null,
    });
  } else {
    if (!gmailServiceAccount())
      return failure(
        "unavailable",
        "This deployment has no Gmail service account. Set INTAKE_GMAIL_SERVICE_ACCOUNT_KEY first.",
      );
    try {
      const profile = await gmailProfile(mailbox);
      patch.gmail_history_id = profile.historyId;
    } catch (error) {
      return mailboxFailure(error, "Couldn't reach Gmail to check the mailbox. Try again.");
    }
    Object.assign(patch, { graph_delta_link: null, graph_subscription_id: null, graph_subscription_expires_at: null });
  }
  const { error } = await db.from("intake_automation").update(patch).eq("org_id", scope.orgId);
  if (error) return internalFailure(error);
  try {
    await startMailboxPolling(db, scope.orgId);
  } catch (cause) {
    return internalFailure(cause);
  }
  const updated = await ensureRow(db, scope);
  if (!updated.ok) return updated;
  // The test message to the admin: best effort, the button sends another.
  if (scope.userEmail) await sendTest(updated.data, scope.userEmail).catch(() => undefined);
  return present(db, scope, updated.data);
}

/** Stop reading the intake mailbox. The sender domains stay for next time. */
export async function disconnectIntakeMailbox(
  db: Db,
  scope: IntakeScope,
): Promise<ServiceResult<IntakeAutomationSettings>> {
  const refused = await denied(db, scope);
  if (refused) return refused;
  const current = await ensureRow(db, scope);
  if (!current.ok) return current;
  const row = current.data;
  const secret = graphClientSecret(row);
  if (row.graph_subscription_id && row.graph_tenant_id && row.graph_client_id && secret && row.email_mailbox)
    await graphUnsubscribe(
      { tenantId: row.graph_tenant_id, clientId: row.graph_client_id, clientSecret: secret, mailbox: row.email_mailbox },
      row.graph_subscription_id,
    );
  const { error } = await db
    .from("intake_automation")
    .update({
      email_enabled: false,
      email_provider: null,
      email_error: null,
      graph_subscription_id: null,
      graph_subscription_expires_at: null,
      graph_client_state_hash: null,
      graph_delta_link: null,
      gmail_history_id: null,
      configured_by: scope.actorId,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", scope.orgId);
  if (error) return internalFailure(error);
  const updated = await ensureRow(db, scope);
  if (!updated.ok) return updated;
  return present(db, scope, updated.data);
}

async function sendTest(row: AutomationRow, to: string) {
  const fromName = row.email_from_name?.trim() || "Legal";
  if (row.email_provider === "graph") {
    const secret = graphClientSecret(row);
    if (!secret || !row.graph_tenant_id || !row.graph_client_id || !row.email_mailbox)
      throw new Error("not connected");
    await graphSendTest(
      { tenantId: row.graph_tenant_id, clientId: row.graph_client_id, clientSecret: secret, mailbox: row.email_mailbox },
      to,
      fromName,
    );
  } else if (row.email_provider === "gmail" && row.email_mailbox) {
    await gmailSendTest(row.email_mailbox, to, fromName);
  } else throw new Error("not connected");
}

/** Send a test email from the intake mailbox to the admin asking. */
export async function sendIntakeMailboxTest(
  db: Db,
  scope: IntakeScope & { userEmail?: string | null },
): Promise<ServiceResult<{ sent_to: string }>> {
  const refused = await denied(db, scope);
  if (refused) return refused;
  const current = await ensureRow(db, scope);
  if (!current.ok) return current;
  if (!current.data.email_provider)
    return failure("validation", "Connect the intake mailbox first.");
  const to = scope.userEmail?.trim();
  if (!to) return failure("validation", "Your account has no email address to send the test to.");
  try {
    await sendTest(current.data, to);
  } catch (error) {
    return mailboxFailure(error, "Couldn't send the test email. Try again.");
  }
  return ok({ sent_to: to });
}
