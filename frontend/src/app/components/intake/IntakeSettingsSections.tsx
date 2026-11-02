"use client";

import { useId, useMemo, type ReactNode } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  Inbox,
  Info,
  Mail,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import type {
  IntakeAutomationSettings,
  IntakeEmailWebhook,
  IntakeInboundSummary,
  IntakeMember,
} from "@mike/contracts";
import { FormTextInput } from "@/app/components/ui/form-field";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { notifyError, notifySuccess } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import {
  INTAKE_INBOUND_STATUS_LABELS,
  INTAKE_SOURCE_LABELS,
  MAX_INTAKE_FOCUS,
  intakeDomainInputError,
  intakeTimezoneError,
  normalizeIntakeDomain,
  type IntakeAutomationDraft,
} from "./intakeAutomation";
import {
  formatIntakeDateTime,
  intakeMemberName,
  intakeTimezones,
} from "./intakeLabels";
import { intakeRequestHref } from "./intakeQuery";

const SECTION_HEADING = "text-sm font-medium text-gray-900";
const LABEL_CLASS = "mb-1.5 block text-xs font-medium text-gray-500";
const HINT_CLASS = "mt-1 text-xs text-gray-500";
const ERROR_CLASS = "mt-1 text-xs text-red-600";
const FIELD_CLASS = "h-9";
/** The cards' rows: the same padding as the request page's panels. */
const ROW_CLASS = "p-5";

type Change = (patch: Partial<IntakeAutomationDraft>) => void;

/**
 * One section of the page: a card whose heading names it, a sentence on
 * what it does and its setup steps, then its rows.
 */
function IntakeSettingsCard({
  title,
  icon,
  description,
  steps,
  children,
}: {
  title: string;
  icon: ReactNode;
  description?: ReactNode;
  /** How to set it up, in order. */
  steps?: string[];
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <GlassCardUI>
      <section aria-labelledby={heading} className="divide-y divide-gray-100">
        <div className={ROW_CLASS}>
          <h2
            id={heading}
            className={cn(SECTION_HEADING, "flex items-center gap-2")}
          >
            <span
              aria-hidden="true"
              className="text-gray-500 [&>svg]:h-4 [&>svg]:w-4"
            >
              {icon}
            </span>
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-xs text-gray-500">{description}</p>
          )}
          {steps && (
            <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-gray-500 marker:text-gray-400">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
        {children}
      </section>
    </GlassCardUI>
  );
}

/** A setting turned on or off, named by its visible label. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className={cn(ROW_CLASS, "flex items-start justify-between gap-4")}>
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-medium text-gray-900">
          {label}
        </p>
        {description && (
          <p id={descriptionId} className="mt-0.5 text-xs text-gray-500">
            {description}
          </p>
        )}
      </div>
      <ToggleSwitchUI
        checked={checked}
        onCheckedChange={onChange}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

/**
 * A value to paste elsewhere, such as a webhook URL: shown whole, wrapping
 * rather than scrolling, with a button that copies it.
 */
function CopyValue({
  label,
  name,
  value,
  children,
}: {
  label: string;
  /** What the copy button copies, for its accessible name. */
  name: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <TextButtonUI
          size="xs"
          // Names what it copies; the visible "Copy" starts the name.
          aria-label={`Copy ${name}`}
          onClick={() =>
            // Inside the promise, so a browser without clipboard access
            // reports it like any other failure.
            Promise.resolve()
              .then(() => navigator.clipboard.writeText(value))
              .then(
                () => notifySuccess(`${label} copied`),
                (e) => notifyError(e, { action: `copy the ${name}` }),
              )
          }
        >
          <Copy aria-hidden="true" className="h-3 w-3" />
          Copy
        </TextButtonUI>
      </div>
      <TextSlabUI>
        <code className="block font-mono text-xs text-gray-900 [overflow-wrap:anywhere]">
          {value}
        </code>
      </TextSlabUI>
      {children}
    </div>
  );
}

/** "Saved" beside a write-only field whose value is kept. */
function SavedMark() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
      <Check aria-hidden="true" className="h-3 w-3 text-emerald-600" />
      Saved
    </span>
  );
}

/**
 * Email: forward a shared address to Postmark, which posts each message to
 * a secret webhook URL MikeGC generates. The URL is shown once.
 */
export function IntakeEmailSection({
  settings,
  draft,
  webhook,
  generating,
  onChange,
  onGenerate,
}: {
  settings: IntakeAutomationSettings["email"];
  draft: IntakeAutomationDraft;
  /** A URL generated on this visit; it is never shown again. */
  webhook: IntakeEmailWebhook | null;
  generating: boolean;
  onChange: Change;
  onGenerate: () => void;
}) {
  const domainId = useId();
  const domainError = intakeDomainInputError(draft);
  const addDomain = () => {
    const domain = normalizeIntakeDomain(draft.domainInput);
    if (!domain || domainError) return;
    onChange({
      domains: draft.domains.includes(domain)
        ? draft.domains
        : [...draft.domains, domain],
      domainInput: "",
    });
  };
  return (
    <IntakeSettingsCard
      title="Email"
      icon={<Mail />}
      description="Forward a shared address, such as legal-intake@company.com, and MikeGC records each message sent to it as a request."
      steps={[
        "Generate the webhook URL below and copy it.",
        "In Postmark, open your server's Inbound stream and paste it as the Webhook URL.",
        "Forward your intake address to the stream's inbound address, then turn email on and save.",
      ]}
    >
      <ToggleRow
        label="Record requests from email"
        checked={draft.emailEnabled}
        onChange={(emailEnabled) => onChange({ emailEnabled })}
      />
      <div className={cn(ROW_CLASS, "space-y-3")}>
        {webhook ? (
          <CopyValue
            label="Webhook URL"
            name="webhook URL"
            value={webhook.webhook_url}
          >
            <p role="status" className={HINT_CLASS}>
              Copy it now: MikeGC won&apos;t show it again.
            </p>
          </CopyValue>
        ) : (
          <p className="text-sm text-gray-900 [overflow-wrap:anywhere]">
            {!settings.configured
              ? "No webhook URL yet."
              : settings.token_hint
                ? `Webhook URL ending …${settings.token_hint}`
                : "A webhook URL is set."}
          </p>
        )}
        <PillButtonUI
          tone="white"
          size="sm"
          loading={generating}
          onClick={onGenerate}
        >
          {settings.configured ? "Replace webhook URL" : "Generate webhook URL"}
        </PillButtonUI>
      </div>
      <div className={ROW_CLASS}>
        <label htmlFor={domainId} className={LABEL_CLASS}>
          Allowed sender domains
        </label>
        {draft.domains.length > 0 && (
          <ul className="mb-2 space-y-1">
            {draft.domains.map((domain) => (
              <li
                key={domain}
                className="flex min-w-0 items-center justify-between gap-2 text-sm text-gray-900"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {domain}
                </span>
                <TextButtonUI
                  size="icon-xs"
                  aria-label={`Remove ${domain}`}
                  onClick={() =>
                    onChange({
                      domains: draft.domains.filter((item) => item !== domain),
                    })
                  }
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </TextButtonUI>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <FormTextInput
            id={domainId}
            className={FIELD_CLASS}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            maxLength={253}
            value={draft.domainInput}
            aria-invalid={!!domainError}
            aria-describedby={`${domainId}-hint${domainError ? ` ${domainId}-error` : ""}`}
            onChange={(event) => onChange({ domainInput: event.target.value })}
            onKeyDown={(event) => {
              // Enter adds the domain rather than saving the page.
              if (event.key !== "Enter") return;
              event.preventDefault();
              addDomain();
            }}
          />
          <PillButtonUI
            tone="white"
            size="sm"
            className="h-9 shrink-0"
            disabled={!draft.domainInput.trim() || !!domainError}
            onClick={addDomain}
          >
            Add
          </PillButtonUI>
        </div>
        {domainError && (
          <p id={`${domainId}-error`} className={ERROR_CLASS}>
            {domainError}
          </p>
        )}
        <p id={`${domainId}-hint`} className={HINT_CLASS}>
          {draft.domains.length
            ? "Only mail from these domains is recorded."
            : "Mail from any sender is recorded. Add a domain to accept only mail from it."}
        </p>
      </div>
    </IntakeSettingsCard>
  );
}

/** A write-only secret: never shown, kept when left empty. */
function SecretField({
  label,
  saved,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  saved: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-gray-500">
          {label}
        </label>
        {saved && !value && <SavedMark />}
      </div>
      <FormTextInput
        id={id}
        type="password"
        className={FIELD_CLASS}
        // Not a sign-in: keep the browser from filling a saved password.
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        placeholder={saved ? "Paste a new one to replace it" : placeholder}
        aria-describedby={saved ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {saved && (
        <p id={`${id}-hint`} className={HINT_CLASS}>
          Leave empty to keep the saved one.
        </p>
      )}
    </div>
  );
}

/**
 * Slack: a Slack app called MikeGC posts each @MikeGC mention to its events
 * URL; its signing secret and bot token are saved here, write-only.
 */
export function IntakeSlackSection({
  settings,
  draft,
  onChange,
}: {
  settings: IntakeAutomationSettings["slack"];
  draft: IntakeAutomationDraft;
  onChange: Change;
}) {
  return (
    <IntakeSettingsCard
      title="Slack"
      icon={<MessageSquare />}
      description="People write @MikeGC in Slack to send a message, or the thread it's in, to Legal."
      steps={[
        "Create a Slack app called MikeGC and install it to your workspace.",
        "Paste its Signing Secret and Bot User OAuth Token below and save.",
        "In the app's Event Subscriptions, paste the Events Request URL, subscribe to the app_mention bot event, then invite @MikeGC to your channels.",
      ]}
    >
      <ToggleRow
        label="Record requests from Slack"
        checked={draft.slackEnabled}
        onChange={(slackEnabled) => onChange({ slackEnabled })}
      />
      <div className={ROW_CLASS}>
        <CopyValue
          label="Events Request URL"
          name="Events Request URL"
          value={settings.events_url}
        />
      </div>
      <div className={cn(ROW_CLASS, "space-y-4")}>
        <SecretField
          label="Signing Secret"
          saved={settings.configured}
          value={draft.signingSecret}
          placeholder="Paste the app's Signing Secret"
          onChange={(signingSecret) => onChange({ signingSecret })}
        />
        <SecretField
          label="Bot User OAuth Token"
          saved={settings.configured}
          value={draft.botToken}
          placeholder="xoxb-…"
          onChange={(botToken) => onChange({ botToken })}
        />
        {settings.configured && (settings.team_name || settings.team_id) && (
          <div>
            <p className={LABEL_CLASS}>Connected workspace</p>
            <p className="text-sm text-gray-900 [overflow-wrap:anywhere]">
              {settings.team_name ?? settings.team_id}
            </p>
            {settings.bot_user_id && (
              <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">
                MikeGC bot user {settings.bot_user_id}
              </p>
            )}
          </div>
        )}
      </div>
    </IntakeSettingsCard>
  );
}

/**
 * AI triage: whether MikeGC summarises, fills in and assigns what it
 * records, the timezone it reads dates in, and what each member handles.
 */
export function IntakeTriageSection({
  settings,
  draft,
  members,
  modelSettingsHref,
  onChange,
}: {
  settings: IntakeAutomationSettings["triage"];
  draft: IntakeAutomationDraft;
  /** Null in Personal, where every request is the owner's. */
  members: IntakeMember[] | null;
  /** Where the model keys triage needs are set. */
  modelSettingsHref: string;
  onChange: Change;
}) {
  const timezoneId = useId();
  const timezoneListId = useId();
  const timezones = useMemo(() => intakeTimezones(), []);
  const timezoneError = intakeTimezoneError(draft);
  return (
    <IntakeSettingsCard title="AI triage" icon={<Sparkles />}>
      <ToggleRow
        label="Summarize, fill in details and assign with AI"
        description={
          members
            ? "MikeGC writes the subject and summary, fills in the requester and target date, assigns the member who handles that kind of work and has room for it, and attaches the documents that matter. Off, it records each message as it arrived, unassigned."
            : "MikeGC writes the subject and summary, fills in the requester and target date, and attaches the documents that matter. Off, it records each message as it arrived."
        }
        checked={draft.triageEnabled}
        onChange={(triageEnabled) => onChange({ triageEnabled })}
      />
      {!settings.model_available && (
        <div className={ROW_CLASS}>
          <TextSlabUI className="flex items-start gap-2 text-xs text-gray-700">
            <Info
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500"
            />
            <p>
              Triage needs a model API key, and none is available, so MikeGC
              records requests without AI.{" "}
              <Link
                href={modelSettingsHref}
                className={textButtonUIClassName({
                  size: "xs",
                  className:
                    "inline px-0 text-xs text-blue-600 underline hover:text-blue-700",
                })}
              >
                Add a key in Bring Your Own Keys
              </Link>
            </p>
          </TextSlabUI>
        </div>
      )}
      <div className={ROW_CLASS}>
        <label htmlFor={timezoneId} className={LABEL_CLASS}>
          Default timezone
        </label>
        <FormTextInput
          id={timezoneId}
          list={timezoneListId}
          className={cn(FIELD_CLASS, "max-w-sm")}
          placeholder="UTC"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          value={draft.timezone}
          aria-invalid={!!timezoneError}
          aria-describedby={`${timezoneId}-hint${timezoneError ? ` ${timezoneId}-error` : ""}`}
          onChange={(event) => onChange({ timezone: event.target.value })}
        />
        <datalist id={timezoneListId}>
          {timezones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {timezoneError && (
          <p id={`${timezoneId}-error`} className={ERROR_CLASS}>
            {timezoneError}
          </p>
        )}
        <p id={`${timezoneId}-hint`} className={HINT_CLASS}>
          Target dates in messages are read in this timezone. Leave empty for
          UTC.
        </p>
      </div>
      {members && (
        <MemberFocus members={members} draft={draft} onChange={onChange} />
      )}
    </IntakeSettingsCard>
  );
}

/** What each member handles, which triage reads to choose a reviewer. */
function MemberFocus({
  members,
  draft,
  onChange,
}: {
  members: IntakeMember[];
  draft: IntakeAutomationDraft;
  onChange: Change;
}) {
  const headingId = useId();
  return (
    <div className={cn(ROW_CLASS, "@container")}>
      <p id={headingId} className="text-sm font-medium text-gray-900">
        What each member handles
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        A few words each, such as &ldquo;NDAs and procurement contracts&rdquo;.
        Triage reads these, and how many open requests each member has, to
        choose a reviewer.
      </p>
      {members.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">No members.</p>
      ) : (
        <ul aria-labelledby={headingId} className="mt-3 space-y-4">
          {members.map((member) => (
            <MemberFocusRow
              key={member.user_id}
              member={member}
              value={draft.focus[member.user_id] ?? ""}
              onChange={(text) =>
                onChange({ focus: { ...draft.focus, [member.user_id]: text } })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemberFocusRow({
  member,
  value,
  onChange,
}: {
  member: IntakeMember;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const nameId = useId();
  const name = intakeMemberName(member);
  return (
    <li className="flex flex-col gap-2 @[36rem]:flex-row @[36rem]:items-start @[36rem]:gap-4">
      {/* Name and email on their own lines, wrapping rather than clipping. */}
      <div className="flex min-w-0 items-start gap-2 @[36rem]:w-56 @[36rem]:shrink-0 @[36rem]:pt-2">
        <span aria-hidden="true" className="flex pt-0.5">
          <UserAvatar
            name={member.display_name}
            email={member.email}
            photo={member.profile_photo}
          />
        </span>
        <div className="min-w-0">
          <p
            id={nameId}
            className="text-sm text-gray-900 [overflow-wrap:anywhere]"
          >
            {name}
          </p>
          {member.display_name && member.email && (
            <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">
              {member.email}
            </p>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <label id={`${id}-label`} htmlFor={id} className={LABEL_CLASS}>
          Handles
        </label>
        <FormTextInput
          id={id}
          // Read as "<member> Handles", since every row has a Handles field.
          aria-labelledby={`${nameId} ${id}-label`}
          className={FIELD_CLASS}
          maxLength={MAX_INTAKE_FOCUS}
          placeholder="Such as NDAs and procurement contracts"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </li>
  );
}

/** The latest messages received and what became of each. */
export function IntakeRecentMessages({
  orgId,
  recent,
}: {
  orgId: string;
  recent: IntakeInboundSummary[];
}) {
  return (
    <IntakeSettingsCard
      title="Recent messages"
      icon={<Inbox />}
      description="The latest messages MikeGC received, newest first."
    >
      {recent.length === 0 ? (
        <p className={cn(ROW_CLASS, "text-sm text-gray-500")}>
          No messages yet. Once email or Slack is on, send a test message and it
          appears here.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {recent.map((message) => {
            const source = INTAKE_SOURCE_LABELS[message.source];
            const received = formatIntakeDateTime(message.created_at);
            return (
              <li
                key={message.id}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm text-gray-900">
                    {source}
                    <span className="text-gray-500">
                      {" · "}
                      <time dateTime={message.created_at}>{received}</time>
                    </span>
                  </p>
                  {message.error && (
                    <p className="mt-0.5 text-xs text-gray-500 [overflow-wrap:anywhere]">
                      {message.error}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span
                    className={
                      message.status === "failed"
                        ? "text-red-600"
                        : "text-gray-500"
                    }
                  >
                    {INTAKE_INBOUND_STATUS_LABELS[message.status]}
                  </span>
                  {message.request_id && (
                    <Link
                      href={intakeRequestHref(orgId, message.request_id)}
                      className={textButtonUIClassName({
                        size: "xs",
                        className: "px-0 text-blue-600 hover:text-blue-700",
                      })}
                    >
                      Open request
                      <span className="sr-only">
                        {` from ${message.source === "email" ? "email" : "Slack"}, received ${received}`}
                      </span>
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </IntakeSettingsCard>
  );
}
