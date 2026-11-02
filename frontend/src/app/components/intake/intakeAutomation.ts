import type {
  IntakeAutomationSettings,
  IntakeAutomationUpdate,
  IntakeInboundSummary,
} from "@mike/contracts";
import { isKnownTimezone } from "./intakeLabels";

/** The most sender domains the API keeps. */
export const MAX_INTAKE_DOMAINS = 50;
/** The longest note of what a member handles. */
export const MAX_INTAKE_FOCUS = 500;

/**
 * Automated intake's settings as they are being edited. Secrets start empty,
 * and empty keeps the saved one; nothing is sent until Save.
 */
export type IntakeAutomationDraft = {
  emailEnabled: boolean;
  domains: string[];
  /** A domain typed but not yet added; Save adds it when it is valid. */
  domainInput: string;
  slackEnabled: boolean;
  signingSecret: string;
  botToken: string;
  triageEnabled: boolean;
  /** Empty means UTC. */
  timezone: string;
  /** What each member handles, by user ID; empty means nothing noted. */
  focus: Record<string, string>;
};

export function intakeAutomationDraft(
  settings: IntakeAutomationSettings,
): IntakeAutomationDraft {
  return {
    emailEnabled: settings.email.enabled,
    domains: [...settings.email.allowed_domains],
    domainInput: "",
    slackEnabled: settings.slack.enabled,
    signingSecret: "",
    botToken: "",
    triageEnabled: settings.triage.enabled,
    timezone: settings.triage.default_timezone ?? "",
    focus: Object.fromEntries(
      settings.focus.map((entry) => [entry.user_id, entry.focus]),
    ),
  };
}

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/**
 * A sender domain as the API keeps it, such as "example.com", or null when
 * the text is not one. An address or "@example.com" gives its domain.
 */
export function normalizeIntakeDomain(text: string): string | null {
  const domain = text
    .trim()
    .toLowerCase()
    .replace(/^.*@/, "")
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
  return DOMAIN.test(domain) ? domain : null;
}

/** Why the typed domain cannot be added, or null when it can (or is empty). */
export function intakeDomainInputError(draft: IntakeAutomationDraft) {
  if (!draft.domainInput.trim()) return null;
  const domain = normalizeIntakeDomain(draft.domainInput);
  if (!domain) return "Enter a domain like example.com.";
  if (
    !draft.domains.includes(domain) &&
    draft.domains.length >= MAX_INTAKE_DOMAINS
  )
    return `Up to ${MAX_INTAKE_DOMAINS} domains can be listed.`;
  return null;
}

/** The domains Save would keep: the list, and the typed one when valid. */
export function intakeDraftDomains(draft: IntakeAutomationDraft): string[] {
  const typed = normalizeIntakeDomain(draft.domainInput);
  return typed &&
    !draft.domains.includes(typed) &&
    !intakeDomainInputError(draft)
    ? [...draft.domains, typed]
    : draft.domains;
}

/** Why the timezone cannot be saved, or null when it can. */
export function intakeTimezoneError(draft: IntakeAutomationDraft) {
  const timezone = draft.timezone.trim();
  return timezone && !isKnownTimezone(timezone)
    ? "Choose a timezone from the list, such as Europe/London."
    : null;
}

function focusEntries(focus: Record<string, string>) {
  return Object.entries(focus)
    .map(([user_id, text]) => ({ user_id, focus: text.trim() }))
    .filter((entry) => entry.focus);
}

function sameFocus(
  a: { user_id: string; focus: string }[],
  b: { user_id: string; focus: string }[],
) {
  const saved = new Map(b.map((entry) => [entry.user_id, entry.focus.trim()]));
  return (
    a.length === saved.size &&
    a.every((entry) => saved.get(entry.user_id) === entry.focus)
  );
}

/**
 * Only what the draft changes, so a save never overwrites a setting with the
 * value it already had. Secrets are sent only when one was typed.
 */
export function intakeAutomationChanges(
  settings: IntakeAutomationSettings,
  draft: IntakeAutomationDraft,
): IntakeAutomationUpdate {
  const update: IntakeAutomationUpdate = {};
  if (draft.emailEnabled !== settings.email.enabled)
    update.email_enabled = draft.emailEnabled;
  const domains = intakeDraftDomains(draft);
  const saved = settings.email.allowed_domains;
  if (
    domains.length !== saved.length ||
    domains.some((domain, index) => domain !== saved[index])
  )
    update.email_allowed_domains = domains;
  if (draft.slackEnabled !== settings.slack.enabled)
    update.slack_enabled = draft.slackEnabled;
  const signingSecret = draft.signingSecret.trim();
  if (signingSecret) update.slack_signing_secret = signingSecret;
  const botToken = draft.botToken.trim();
  if (botToken) update.slack_bot_token = botToken;
  if (draft.triageEnabled !== settings.triage.enabled)
    update.triage_enabled = draft.triageEnabled;
  const timezone = draft.timezone.trim() || null;
  if (timezone !== settings.triage.default_timezone)
    update.default_timezone = timezone;
  const focus = focusEntries(draft.focus);
  if (!sameFocus(focus, settings.focus)) update.focus = focus;
  return update;
}

export const INTAKE_SOURCE_LABELS: Record<
  IntakeInboundSummary["source"],
  string
> = { email: "Email", slack: "Slack" };

/** What happened to a received message, as an admin reads it. */
export const INTAKE_INBOUND_STATUS_LABELS: Record<
  IntakeInboundSummary["status"],
  string
> = {
  pending: "Processing",
  done: "Recorded",
  failed: "Failed",
  ignored: "Ignored",
};
