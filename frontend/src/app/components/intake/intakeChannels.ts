import type {
  IntakeAutomationSettings,
  IntakeMailboxConnection,
  IntakeMailProvider,
} from "@mike/contracts";
import {
  intakeAutomationDraft,
  type IntakeAutomationDraft,
} from "./intakeAutomation";

/** The channels MikeGC records requests from, each set up in its own modal. */
export type IntakeChannelId = "email" | "slack" | "teams";

export const INTAKE_CHANNEL_NAMES: Record<IntakeChannelId, string> = {
  email: "Email",
  slack: "Slack",
  teams: "Teams",
};

/** The mail systems an intake mailbox can be on, as Legal names them. */
export const INTAKE_MAIL_PROVIDER_LABELS: Record<IntakeMailProvider, string> = {
  graph: "Outlook (Microsoft 365)",
  gmail: "Gmail (Google Workspace)",
};
const MAIL_PROVIDER_SHORT: Record<IntakeMailProvider, string> = {
  graph: "Outlook",
  gmail: "Gmail",
};

/** What each channel does and how to set it up, shown in its modal. */
export const INTAKE_CHANNEL_GUIDES: Record<
  IntakeChannelId,
  { description: string; steps: string[] }
> = {
  email: {
    description:
      "People in your company email requests to an intake address, such as intake@company.com. MikeGC reads new mail there, records each request, and replies from the same address so answers stay in the thread.",
    steps: [
      "Outlook: register an app in Microsoft Entra ID (or reuse the Teams one), grant it the Mail.ReadWrite and Mail.Send application permissions with admin consent, and limit it to the intake mailbox with an Exchange RBAC for Applications management scope.",
      "Gmail: in the Google Admin console, add this deployment's service account client ID under domain-wide delegation with the gmail.modify scope.",
      "Choose Connect and enter the intake address and, for Outlook, the tenant ID, client ID and client secret.",
      "Add the company's sender domains. The intake address's own domain is accepted from the start; mail from other domains is recorded as ignored.",
      "Send a test email, then email a request to the intake address and check that it appears in Intake.",
    ],
  },
  slack: {
    description:
      "People write @MikeGC in Slack to send a message, or the thread it's in, to Legal. MikeGC asks for missing details, posts a lawyer's questions and replies with the resolution in the same thread.",
    steps: [
      "Create a Slack app called MikeGC from the manifest in the setup guide and install it to your workspace.",
      "Paste the app's Signing Secret and Bot User OAuth Token here and save.",
      "In the app's Event Subscriptions, paste the Events Request URL and subscribe to the app_mention, message.channels and message.groups bot events.",
      "Invite @MikeGC to the channels people ask Legal in.",
    ],
  },
  teams: {
    description:
      "People write @MikeGC in a Teams channel to send a message, or the thread it's in, to Legal. MikeGC asks for missing details, posts a lawyer's questions and replies with the resolution in the same thread.",
    steps: [
      "In Microsoft Entra ID, register a single-tenant app and create a client secret.",
      "Create an Azure Bot for that app ID, set its messaging endpoint to the Teams events URL, and turn on the Microsoft Teams channel.",
      "Upload the Teams app package built from the manifest in the setup guide to your app catalog, then add it to the teams whose channels ask Legal. A team owner consents to it reading channel messages.",
      "For documents, grant the app Microsoft Graph Sites.Selected for those teams' sites (or Files.ReadWrite.All) with admin consent.",
      "Enter the app ID, tenant ID and client secret here, turn Teams on and save.",
    ],
  },
};

/**
 * What a channel's card says: whether it is set up (its button reads Set up
 * or Manage), one line of status, and a warning when something needs
 * attention.
 */
export type IntakeChannelSummary = {
  configured: boolean;
  status: string;
  warning: string | null;
};

export function intakeChannelSummary(
  settings: IntakeAutomationSettings,
  channel: IntakeChannelId,
): IntakeChannelSummary {
  const onOff = (enabled: boolean) => (enabled ? "On" : "Off");
  if (channel === "email") {
    const email = settings.email;
    if (!email.provider)
      return {
        configured: false,
        status: "Not set up",
        warning: email.needs_reconnect
          ? "Connect your intake mailbox to keep recording email."
          : null,
      };
    return {
      configured: true,
      status: [
        onOff(email.enabled),
        email.mailbox,
        MAIL_PROVIDER_SHORT[email.provider],
      ]
        .filter(Boolean)
        .join(" · "),
      warning: email.status.error,
    };
  }
  if (channel === "slack") {
    const slack = settings.slack;
    if (!slack.configured)
      return { configured: false, status: "Not set up", warning: null };
    return {
      configured: true,
      status: `${onOff(slack.enabled)} · ${slack.team_name ?? slack.team_id ?? "Slack workspace"}`,
      warning: slack.missing_scopes.length
        ? "Reinstall the Slack app to send documents."
        : !slack.message_events_seen
          ? "No thread messages yet: check the app's message events."
          : null,
    };
  }
  const teams = settings.teams;
  if (!teams.configured)
    return { configured: false, status: "Not set up", warning: null };
  return {
    configured: true,
    status:
      onOff(teams.enabled) +
      (teams.files_access ? " · Documents can be sent" : ""),
    warning:
      teams.files_access === false
        ? "Document access isn't set up, so MikeGC posts text only."
        : null,
  };
}

/** What the connect form holds; the client secret is write-only. */
export type IntakeMailboxForm = {
  provider: IntakeMailProvider;
  mailbox: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The connect form for `provider`, starting from what is saved. */
export function intakeMailboxForm(
  provider: IntakeMailProvider,
  email: IntakeAutomationSettings["email"],
): IntakeMailboxForm {
  const same = email.provider === provider;
  return {
    provider,
    mailbox: same ? (email.mailbox ?? "") : "",
    tenantId: same ? (email.graph.tenant_id ?? "") : "",
    clientId: same ? (email.graph.client_id ?? "") : "",
    clientSecret: "",
  };
}

/** Why the connect form can't be sent yet, or null when it can. */
export function intakeMailboxFormProblem(
  form: IntakeMailboxForm,
  secretSaved: boolean,
): string | null {
  if (!EMAIL_SHAPE.test(form.mailbox.trim()))
    return "Enter the intake address, such as intake@company.com.";
  if (form.provider === "gmail") return null;
  if (!form.tenantId.trim()) return "Enter the Microsoft 365 tenant ID.";
  if (!form.clientId.trim()) return "Enter the Entra app's client ID.";
  if (!form.clientSecret.trim() && !secretSaved)
    return "Enter the Entra app's client secret.";
  return null;
}

/** The connection as the API takes it; an empty secret keeps the saved one. */
export function intakeMailboxConnection(
  form: IntakeMailboxForm,
): IntakeMailboxConnection {
  const mailbox = form.mailbox.trim();
  if (form.provider === "gmail") return { provider: "gmail", mailbox };
  const secret = form.clientSecret.trim();
  return {
    provider: "graph",
    mailbox,
    tenant_id: form.tenantId.trim(),
    client_id: form.clientId.trim(),
    ...(secret ? { client_secret: secret } : {}),
  };
}

/**
 * The page's draft once a channel's modal saved: every channel field takes
 * what the server now has, so the page's own autosave never sends an older
 * value back.
 */
export function intakeDraftWithChannels(
  draft: IntakeAutomationDraft,
  settings: IntakeAutomationSettings,
): IntakeAutomationDraft {
  const fresh = intakeAutomationDraft(settings);
  return {
    ...draft,
    emailEnabled: fresh.emailEnabled,
    domains: fresh.domains,
    domainInput: "",
    fromName: fresh.fromName,
    slackEnabled: fresh.slackEnabled,
    signingSecret: "",
    botToken: "",
    teamsEnabled: fresh.teamsEnabled,
    teamsAppId: fresh.teamsAppId,
    teamsTenantId: fresh.teamsTenantId,
    teamsSecret: "",
  };
}
