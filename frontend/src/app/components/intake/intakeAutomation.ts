import type {
  IntakeAssignmentRule,
  IntakeAutomationSettings,
  IntakeAutomationUpdate,
  IntakePreprocessRule,
} from "@mike/contracts";

/** The most sender domains the API keeps. */
export const MAX_INTAKE_DOMAINS = 50;
/** The longest condition an assignment rule can have. */
export const MAX_INTAKE_RULE_CONDITION = 500;
/** The most assignment rules the API keeps. */
export const MAX_INTAKE_RULES = 100;

/**
 * An assignment rule being edited. It saves once it has both a condition and
 * a member; until then it stays on the page only.
 */
export type IntakeRuleDraft = {
  /** Tells rules apart while they are added, moved and removed. */
  key: string;
  condition: string;
  assigneeId: string | null;
  /** AI preprocessing: MikeGC answers the request and marks up its documents. */
  preprocess: boolean;
  /** The workflow or playbook it follows, with its name when known. */
  preprocessWith: IntakePreprocessRule | null;
  /**
   * The condition and member it was last saved with; null until it saves.
   * While its condition is cleared to be retyped, it keeps saving as this.
   */
  saved?: { condition: string; assigneeId: string } | null;
};

let ruleKeys = 0;

/**
 * The rules with the one keyed `from` moved to just before or after the one
 * keyed `to`, as a drag drops it. Unchanged when either is missing or they
 * are the same rule.
 */
export function moveIntakeRule(
  rules: IntakeRuleDraft[],
  from: string,
  to: string,
  position: "before" | "after",
): IntakeRuleDraft[] {
  const moving = rules.find((rule) => rule.key === from);
  if (!moving || from === to || !rules.some((rule) => rule.key === to))
    return rules;
  const rest = rules.filter((rule) => rule.key !== from);
  const at = rest.findIndex((rule) => rule.key === to);
  rest.splice(position === "before" ? at : at + 1, 0, moving);
  return rest.every((rule, index) => rule === rules[index]) ? rules : rest;
}

export function newIntakeRule(
  rule: Partial<Omit<IntakeRuleDraft, "key">> = {},
): IntakeRuleDraft {
  ruleKeys += 1;
  return {
    condition: "",
    assigneeId: null,
    preprocess: false,
    preprocessWith: null,
    saved: null,
    ...rule,
    key: `rule-${ruleKeys}`,
  };
}

/**
 * Automated intake's settings as they are being edited, which save by
 * themselves. Secrets start empty, and empty keeps the saved one.
 */
export type IntakeAutomationDraft = {
  emailEnabled: boolean;
  domains: string[];
  /** A domain typed but not yet added, which is not saved until it is. */
  domainInput: string;
  slackEnabled: boolean;
  signingSecret: string;
  botToken: string;
  /** The models triage and preprocessing run with; null stops either. */
  triageModel: string | null;
  preprocessingModel: string | null;
  /** Assignment rules in the order triage tries them. */
  rules: IntakeRuleDraft[];
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
    triageModel: settings.models.triage,
    preprocessingModel: settings.models.preprocessing,
    rules: settings.rules.map((rule) =>
      newIntakeRule({
        condition: rule.condition,
        assigneeId: rule.assignee_id,
        preprocess: rule.preprocess,
        preprocessWith: rule.preprocess_with,
        saved: { condition: rule.condition, assigneeId: rule.assignee_id },
      }),
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

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Whether a rule has what it needs to save: a condition and a member. */
export function isCompleteIntakeRule(rule: IntakeRuleDraft) {
  return !!rule.condition.trim() && !!rule.assigneeId;
}

/**
 * Whether a rule is sent when the rules save: once complete, and while a
 * saved rule is incomplete only for being retyped, as it was saved.
 */
function savesRule(rule: IntakeRuleDraft) {
  return isCompleteIntakeRule(rule) || !!rule.saved;
}

/** The rules that save, in order, as the API takes them. */
function savedRules(rules: IntakeRuleDraft[]): IntakeAssignmentRule[] {
  return rules.filter(savesRule).map((rule) => {
    const complete = isCompleteIntakeRule(rule);
    return {
      condition: complete ? rule.condition.trim() : rule.saved!.condition,
      assignee_id: complete ? rule.assigneeId! : rule.saved!.assigneeId,
      preprocess: rule.preprocess,
      // The name is for showing; the saved reference is its kind and id.
      preprocess_with: rule.preprocessWith
        ? { kind: rule.preprocessWith.kind, id: rule.preprocessWith.id }
        : null,
    };
  });
}

function sameReference(
  a: IntakePreprocessRule | null,
  b: IntakePreprocessRule | null,
) {
  return a?.kind === b?.kind && a?.id === b?.id;
}

function sameRules(a: IntakeAssignmentRule[], b: IntakeAssignmentRule[]) {
  return (
    a.length === b.length &&
    a.every(
      (rule, index) =>
        rule.condition === b[index].condition.trim() &&
        rule.assignee_id === b[index].assignee_id &&
        rule.preprocess === b[index].preprocess &&
        sameReference(rule.preprocess_with, b[index].preprocess_with),
    )
  );
}

/**
 * Only what the draft changes, so a save never overwrites a setting with the
 * value it already had. Secrets are sent only when one was typed; a domain
 * not yet added is left for its field to correct, and a rule without a
 * condition or a member until it has both.
 */
export function intakeAutomationChanges(
  settings: IntakeAutomationSettings,
  draft: IntakeAutomationDraft,
): IntakeAutomationUpdate {
  const update: IntakeAutomationUpdate = {};
  if (draft.emailEnabled !== settings.email.enabled)
    update.email_enabled = draft.emailEnabled;
  if (!sameList(draft.domains, settings.email.allowed_domains))
    update.email_allowed_domains = draft.domains;
  if (draft.slackEnabled !== settings.slack.enabled)
    update.slack_enabled = draft.slackEnabled;
  const signingSecret = draft.signingSecret.trim();
  if (signingSecret) update.slack_signing_secret = signingSecret;
  const botToken = draft.botToken.trim();
  if (botToken) update.slack_bot_token = botToken;
  if (draft.triageModel !== settings.models.triage)
    update.triage_model = draft.triageModel;
  if (draft.preprocessingModel !== settings.models.preprocessing)
    update.preprocessing_model = draft.preprocessingModel;
  const rules = savedRules(draft.rules);
  if (!sameRules(rules, settings.rules)) update.rules = rules;
  return update;
}

/**
 * The draft once `sent` has saved as `saved`. Each field still as it was sent
 * takes the saved value, so what the server kept shows and nothing saves
 * twice; a field edited while the save was out keeps the edit, which saves
 * next. A sent secret is cleared, as it is never shown.
 */
export function intakeDraftAfterSave(
  draft: IntakeAutomationDraft,
  sent: IntakeAutomationUpdate,
  saved: IntakeAutomationSettings,
): IntakeAutomationDraft {
  const fresh = intakeAutomationDraft(saved);
  const next = { ...draft };
  if (draft.emailEnabled === sent.email_enabled)
    next.emailEnabled = fresh.emailEnabled;
  if (
    sent.email_allowed_domains &&
    sameList(draft.domains, sent.email_allowed_domains)
  )
    next.domains = fresh.domains;
  if (draft.slackEnabled === sent.slack_enabled)
    next.slackEnabled = fresh.slackEnabled;
  if (
    sent.triage_model !== undefined &&
    draft.triageModel === sent.triage_model
  )
    next.triageModel = fresh.triageModel;
  if (
    sent.preprocessing_model !== undefined &&
    draft.preprocessingModel === sent.preprocessing_model
  )
    next.preprocessingModel = fresh.preprocessingModel;
  if (sent.rules && sameRules(savedRules(draft.rules), sent.rules))
    next.rules = rulesAsSaved(draft.rules, saved.rules);
  if (draft.signingSecret.trim() === sent.slack_signing_secret)
    next.signingSecret = "";
  if (draft.botToken.trim() === sent.slack_bot_token) next.botToken = "";
  return next;
}

/**
 * The draft's rules with the conditions and names the server kept, such as
 * without characters it does not store. Text that differs only in surrounding space
 * stays as typed, so a pause mid-sentence never loses its space; rules not
 * yet complete stay as typed, remembering what they saved as.
 */
function rulesAsSaved(
  rules: IntakeRuleDraft[],
  saved: IntakeAssignmentRule[],
): IntakeRuleDraft[] {
  if (savedRules(rules).length !== saved.length) return rules;
  let index = 0;
  return rules.map((rule) => {
    if (!savesRule(rule)) return rule;
    const kept = saved[index++];
    // The saved rule names its workflow or playbook as the server sees it.
    const named = {
      ...rule,
      preprocessWith: kept.preprocess_with,
      saved: { condition: kept.condition, assigneeId: kept.assignee_id },
    };
    if (!isCompleteIntakeRule(rule)) return named;
    return rule.condition.trim() === kept.condition
      ? named
      : { ...named, condition: kept.condition, assigneeId: kept.assignee_id };
  });
}

/**
 * The draft once `sent` has failed to save. A switch flipped back to what is
 * saved, so it never shows a setting that is not on; text stays as typed, to
 * correct or retry.
 */
export function intakeDraftAfterFailure(
  draft: IntakeAutomationDraft,
  sent: IntakeAutomationUpdate,
  saved: IntakeAutomationSettings,
): IntakeAutomationDraft {
  const next = { ...draft };
  if (draft.emailEnabled === sent.email_enabled)
    next.emailEnabled = saved.email.enabled;
  if (draft.slackEnabled === sent.slack_enabled)
    next.slackEnabled = saved.slack.enabled;
  if (
    sent.triage_model !== undefined &&
    draft.triageModel === sent.triage_model
  )
    next.triageModel = saved.models.triage;
  if (
    sent.preprocessing_model !== undefined &&
    draft.preprocessingModel === sent.preprocessing_model
  )
    next.preprocessingModel = saved.models.preprocessing;
  return next;
}

/**
 * The draft with the switches and models `sent` changed set again, to
 * retry a failed save. One changed again since the failure turned it back
 * keeps the newer choice.
 */
export function intakeDraftWithSwitches(
  draft: IntakeAutomationDraft,
  sent: IntakeAutomationUpdate,
  saved: IntakeAutomationSettings,
): IntakeAutomationDraft {
  const again = <T>(sentValue: T | undefined, current: T, savedValue: T) =>
    sentValue !== undefined && current === savedValue ? sentValue : current;
  return {
    ...draft,
    emailEnabled: again(
      sent.email_enabled,
      draft.emailEnabled,
      saved.email.enabled,
    ),
    slackEnabled: again(
      sent.slack_enabled,
      draft.slackEnabled,
      saved.slack.enabled,
    ),
    triageModel: again(
      sent.triage_model,
      draft.triageModel,
      saved.models.triage,
    ),
    preprocessingModel: again(
      sent.preprocessing_model,
      draft.preprocessingModel,
      saved.models.preprocessing,
    ),
  };
}

/**
 * The draft as autosave sends it. A typed secret goes only once committed,
 * never part-typed. A channel turned on goes only once it can run, as the API
 * refuses it before: email once its webhook URL exists, Slack once both its
 * secrets are saved or are being sent. Until then the switch shows on and
 * the channel's setup stays open.
 */
export function intakeAutosaveDraft(
  settings: IntakeAutomationSettings,
  draft: IntakeAutomationDraft,
  committed: { signingSecret: boolean; botToken: boolean },
): IntakeAutomationDraft {
  const signingSecret = committed.signingSecret ? draft.signingSecret : "";
  const botToken = committed.botToken ? draft.botToken : "";
  const slackReady =
    settings.slack.configured || (!!signingSecret.trim() && !!botToken.trim());
  return {
    ...draft,
    signingSecret,
    botToken,
    emailEnabled:
      draft.emailEnabled && !settings.email.configured
        ? settings.email.enabled
        : draft.emailEnabled,
    slackEnabled:
      draft.slackEnabled && !slackReady
        ? settings.slack.enabled
        : draft.slackEnabled,
  };
}
