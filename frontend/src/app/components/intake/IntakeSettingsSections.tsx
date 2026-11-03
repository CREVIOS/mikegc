"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, Copy, Info, X } from "lucide-react";
import type {
  IntakeAutomationSettings,
  IntakeMailProvider,
} from "@mike/contracts";
import { Modal } from "@/app/components/modals/Modal";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import {
  SETTINGS_CONTROL_CLASS,
  SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { notifyError, notifySuccess } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import {
  MODELS,
  SETTINGS_MODELS,
  modelDisplayName,
  type ModelOption,
} from "@/shared/lib/modelCatalog";
import {
  Dropdown,
  DropdownContent,
  DropdownLabel,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { orderedModelGroups } from "@/shared/ui/ModelToggleUI";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import {
  intakeDomainInputError,
  normalizeIntakeDomain,
  type IntakeAutomationDraft,
} from "./intakeAutomation";

/** Settings' field label, and its label and description beside a switch. */
const LABEL_CLASS = "mb-2 block text-sm font-medium text-gray-700";
const ROW_LABEL_CLASS = "text-sm font-medium text-gray-700";
const ROW_DESCRIPTION_CLASS = "text-sm text-gray-500";
const HINT_CLASS = "mt-1 text-xs text-gray-500";
const ERROR_CLASS = "mt-1 text-xs text-red-600";

type Change = (patch: Partial<IntakeAutomationDraft>) => void;

/**
 * One section of the page, as in Settings: its heading above a card of rows.
 * What it does and its setup steps open in a small modal from the info
 * button beside the heading.
 */
function IntakeSettingsSection({
  title,
  description,
  steps,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** How to set it up, in order. */
  steps?: string[];
  children: ReactNode;
}) {
  const heading = useId();
  const [showGuide, setShowGuide] = useState(false);
  const hasGuide = !!description || !!steps;
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <div className="flex items-center gap-1.5">
        <SettingsHeading id={heading}>{title}</SettingsHeading>
        {hasGuide && (
          <TextButtonUI
            size="icon-xs"
            aria-label={`How to set up ${title}`}
            aria-haspopup="dialog"
            onClick={() => setShowGuide(true)}
          >
            <Info aria-hidden="true" className="h-4 w-4" />
          </TextButtonUI>
        )}
      </div>
      <GlassCardUI>{children}</GlassCardUI>
      {hasGuide && (
        <Modal
          open={showGuide}
          onClose={() => setShowGuide(false)}
          // Where it belongs, then what it is, which names the dialog.
          breadcrumbs={["Intake", "Settings", `Set up ${title}`]}
          size="sm"
          // As tall as its few lines, not a full modal's height.
          className="h-auto"
        >
          <div className="space-y-3 pb-5">
            {description && (
              <SettingsDescription>{description}</SettingsDescription>
            )}
            {steps && (
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-gray-700 marker:text-gray-400">
                {steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            )}
          </div>
        </Modal>
      )}
    </section>
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
    <SettingsRow>
      <div className="min-w-0 space-y-1">
        <p id={labelId} className={ROW_LABEL_CLASS}>
          {label}
        </p>
        {description && (
          <p id={descriptionId} className={ROW_DESCRIPTION_CLASS}>
            {description}
          </p>
        )}
      </div>
      <ToggleSwitchUI
        checked={checked}
        onCheckedChange={onChange}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        className="shrink-0"
      />
    </SettingsRow>
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
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className={ROW_LABEL_CLASS}>{label}</p>
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

/** A note under a setting: what it needs, or why it isn't working. */
function SettingsNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: ReactNode;
}) {
  return (
    <TextSlabUI
      className={cn(
        "flex items-start gap-2 text-xs",
        tone === "error" ? "text-red-700" : "text-gray-700",
      )}
    >
      <Info
        aria-hidden="true"
        className={cn(
          "mt-0.5 h-3.5 w-3.5 shrink-0",
          tone === "error" ? "text-red-600" : "text-gray-500",
        )}
      />
      <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
        {children}
      </div>
    </TextSlabUI>
  );
}

/** A text field that saves as the page does, labelled above it. */
function TextField({
  label,
  value,
  placeholder,
  hint,
  type = "text",
  maxLength,
  autoComplete = "off",
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: ReactNode;
  type?: "text" | "email" | "password";
  maxLength?: number;
  autoComplete?: string;
  onChange: (value: string) => void;
  /** It is typed in full: on leaving the field or Enter. */
  onCommit?: () => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <SettingsTextInput
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Enter commits the field rather than submitting the form.
          event.preventDefault();
          onCommit?.();
        }}
      />
      {hint && (
        <p id={`${id}-hint`} className={HINT_CLASS}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** The mail systems an intake mailbox can be on, as Legal names them. */
export const INTAKE_MAIL_PROVIDER_LABELS: Record<IntakeMailProvider, string> = {
  graph: "Outlook (Microsoft 365)",
  gmail: "Gmail (Google Workspace)",
};

/** What the connect form holds; the client secret is write-only. */
export type IntakeMailboxForm = {
  provider: IntakeMailProvider;
  mailbox: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

/**
 * Connects the intake mailbox: Microsoft 365 through an Entra app the
 * admin registers, or Google Workspace through the deployment's service
 * account with domain-wide delegation. Its error is shown under the form,
 * as for any field being edited.
 */
function MailboxConnectForm({
  form,
  settings,
  connecting,
  error,
  onChange,
  onConnect,
  onCancel,
}: {
  form: IntakeMailboxForm;
  settings: IntakeAutomationSettings["email"];
  connecting: boolean;
  error: string | null;
  onChange: (patch: Partial<IntakeMailboxForm>) => void;
  onConnect: () => void;
  onCancel: () => void;
}) {
  const errorId = useId();
  const secretId = useId();
  const secretSaved =
    settings.provider === "graph" && settings.graph.secret_set;
  const problem = intakeMailboxFormProblem(form, secretSaved);
  const gmailUnavailable = form.provider === "gmail" && !settings.gmail_client_id;
  return (
    <SettingsRow layout="stacked">
      <p className={ROW_LABEL_CLASS}>
        Connect {INTAKE_MAIL_PROVIDER_LABELS[form.provider]}
      </p>
      <TextField
        label="Intake address"
        type="email"
        value={form.mailbox}
        placeholder="intake@company.com"
        maxLength={320}
        hint={
          form.provider === "graph"
            ? "A shared mailbox works best: it needs no licence and no one signs in to it."
            : "A licensed Workspace user account. A Google Group can deliver into it, but can't be connected itself."
        }
        onChange={(mailbox) => onChange({ mailbox })}
      />
      {form.provider === "graph" ? (
        <>
          <TextField
            label="Tenant ID"
            value={form.tenantId}
            placeholder="00000000-0000-0000-0000-000000000000"
            maxLength={100}
            onChange={(tenantId) => onChange({ tenantId })}
          />
          <TextField
            label="Client ID"
            value={form.clientId}
            placeholder="The Entra app's Application (client) ID"
            maxLength={100}
            onChange={(clientId) => onChange({ clientId })}
          />
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor={secretId} className={ROW_LABEL_CLASS}>
                Client secret
              </label>
              {secretSaved && !form.clientSecret && <SavedMark />}
            </div>
            <SettingsTextInput
              id={secretId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={500}
              value={form.clientSecret}
              placeholder={
                secretSaved
                  ? "Paste a new one to replace it"
                  : "The Entra app's client secret value"
              }
              onChange={(event) =>
                onChange({ clientSecret: event.target.value })
              }
            />
            {secretSaved && (
              <p className={HINT_CLASS}>Leave empty to keep the saved one.</p>
            )}
          </div>
        </>
      ) : gmailUnavailable ? (
        <SettingsNotice>
          <p>
            This deployment has no Google service account, so Gmail can&apos;t
            be connected. Its administrator sets
            INTAKE_GMAIL_SERVICE_ACCOUNT_KEY to the service account&apos;s JSON
            key.
          </p>
        </SettingsNotice>
      ) : (
        <CopyValue
          label="Service account client ID"
          name="service account client ID"
          value={settings.gmail_client_id ?? ""}
        >
          <p className={HINT_CLASS}>
            In the Google Admin console, add this client ID under Security,
            API controls, Domain-wide delegation, with the scope
            https://www.googleapis.com/auth/gmail.modify.
          </p>
        </CopyValue>
      )}
      {error && (
        <p id={errorId} role="alert" className={ERROR_CLASS}>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <PillButtonUI
          tone="white"
          size="sm"
          disabled={connecting}
          onClick={onCancel}
        >
          Cancel
        </PillButtonUI>
        <PillButtonUI
          tone="black"
          size="sm"
          loading={connecting}
          disabled={!!problem || gmailUnavailable || connecting}
          aria-describedby={error ? errorId : undefined}
          title={problem ?? undefined}
          onClick={onConnect}
        >
          Connect
        </PillButtonUI>
      </div>
    </SettingsRow>
  );
}

/**
 * Email: MikeGC reads the intake mailbox itself, through Microsoft Graph or
 * the Gmail API, and replies from it, so replies thread and land in its
 * Sent folder. Postmark is retired: an organization that used it reconnects
 * here to keep recording email.
 */
export function IntakeEmailSection({
  settings,
  draft,
  form,
  connecting,
  connectError,
  testing,
  onChange,
  onStartConnect,
  onFormChange,
  onConnect,
  onCancelConnect,
  onDisconnect,
  onTest,
}: {
  settings: IntakeAutomationSettings["email"];
  draft: IntakeAutomationDraft;
  /** The connect form, while it is open. */
  form: IntakeMailboxForm | null;
  connecting: boolean;
  connectError: string | null;
  testing: boolean;
  onChange: Change;
  onStartConnect: (provider: IntakeMailProvider) => void;
  onFormChange: (patch: Partial<IntakeMailboxForm>) => void;
  onConnect: () => void;
  onCancelConnect: () => void;
  onDisconnect: () => void;
  onTest: () => void;
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
  const provider = settings.provider;
  return (
    <IntakeSettingsSection
      title="Email"
      description="People in your company email requests to an intake address, such as intake@company.com. MikeGC reads new mail there, records each request, and replies from the same address so answers stay in the thread."
      steps={[
        "Outlook: register an app in Microsoft Entra ID (or reuse the Teams one), grant it the Mail.ReadWrite and Mail.Send application permissions with admin consent, and limit it to the intake mailbox with an Exchange RBAC for Applications management scope.",
        "Gmail: in the Google Admin console, add this deployment's service account client ID under domain-wide delegation with the gmail.modify scope.",
        "Choose Connect below and enter the intake address and, for Outlook, the tenant ID, client ID and client secret.",
        "Add the company's sender domains. The intake address's own domain is accepted from the start; mail from other domains is recorded as ignored.",
        "Send a test email, then email a request to the intake address and check that it appears in Intake.",
      ]}
    >
      {settings.needs_reconnect && !provider && (
        <SettingsRow layout="stacked">
          <SettingsNotice>
            <p className="font-medium">
              Connect your intake mailbox to keep recording email.
            </p>
            <p>
              MikeGC no longer receives mail through Postmark. Connect the
              mailbox you forwarded from, then remove the forwarding rule.
            </p>
          </SettingsNotice>
        </SettingsRow>
      )}
      {provider ? (
        <>
          <ToggleRow
            label="Record requests from email"
            checked={draft.emailEnabled}
            onChange={(emailEnabled) => onChange({ emailEnabled })}
          />
          <SettingsRow layout="stacked">
            <div className="min-w-0 space-y-1">
              <p className={ROW_LABEL_CLASS}>Intake address</p>
              <p className="text-sm text-gray-900 [overflow-wrap:anywhere]">
                {settings.mailbox}
              </p>
              <p className="text-xs text-gray-500">
                {INTAKE_MAIL_PROVIDER_LABELS[provider]}
              </p>
              {settings.status.last_read_at ? (
                <p className="text-xs text-gray-500">
                  Last read {formatSettingsTime(settings.status.last_read_at)}
                </p>
              ) : (
                <p className="text-xs text-gray-500">Not read yet</p>
              )}
              {provider === "graph" && settings.status.subscription_expires_at && (
                <p className="text-xs text-gray-500">
                  New-mail notifications renew before{" "}
                  {formatSettingsTime(settings.status.subscription_expires_at)}
                </p>
              )}
            </div>
            {settings.status.error && (
              <SettingsNotice tone="error">
                <p role="alert">{settings.status.error}</p>
              </SettingsNotice>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <PillButtonUI
                tone="white"
                size="sm"
                loading={testing}
                disabled={testing || !!form}
                onClick={onTest}
              >
                Send test email
              </PillButtonUI>
              <PillButtonUI
                tone="white"
                size="sm"
                disabled={!!form}
                aria-label={`Reconnect ${INTAKE_MAIL_PROVIDER_LABELS[provider]}`}
                onClick={() => onStartConnect(provider)}
              >
                Reconnect
              </PillButtonUI>
              <PillButtonUI
                tone="danger"
                size="sm"
                disabled={!!form}
                onClick={onDisconnect}
              >
                Disconnect
              </PillButtonUI>
            </div>
          </SettingsRow>
        </>
      ) : (
        !form && (
          <SettingsRow layout="stacked">
            <p className={ROW_DESCRIPTION_CLASS}>
              Connect the mailbox people send requests to. MikeGC reads new
              mail there and replies from it.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <PillButtonUI
                tone="white"
                size="sm"
                onClick={() => onStartConnect("graph")}
              >
                Connect Outlook (Microsoft 365)
              </PillButtonUI>
              <PillButtonUI
                tone="white"
                size="sm"
                onClick={() => onStartConnect("gmail")}
              >
                Connect Gmail (Google Workspace)
              </PillButtonUI>
            </div>
          </SettingsRow>
        )
      )}
      {form && (
        <MailboxConnectForm
          form={form}
          settings={settings}
          connecting={connecting}
          error={connectError}
          onChange={onFormChange}
          onConnect={onConnect}
          onCancel={onCancelConnect}
        />
      )}
      {/* The rest of its setup is shown while a connected mailbox is on. */}
      {provider && draft.emailEnabled && (
        <>
          <SettingsRow layout="stacked">
            <TextField
              label="Sender name"
              value={draft.fromName}
              placeholder="Legal"
              maxLength={100}
              hint={`MikeGC's own emails come from this name at ${settings.mailbox ?? "the intake address"}. A lawyer's message reads "Their name via ${draft.fromName.trim() || "Legal"}".`}
              onChange={(fromName) => onChange({ fromName })}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div>
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
                            domains: draft.domains.filter(
                              (item) => item !== domain,
                            ),
                          })
                        }
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </TextButtonUI>
                    </li>
                  ))}
                </ul>
              )}
              {/* Add sits inside the field, at its end. */}
              <div className="relative">
                <SettingsTextInput
                  id={domainId}
                  className="pr-14"
                  placeholder="example.com"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={253}
                  value={draft.domainInput}
                  aria-invalid={!!domainError}
                  aria-describedby={`${domainId}-hint${domainError ? ` ${domainId}-error` : ""}`}
                  onChange={(event) =>
                    onChange({ domainInput: event.target.value })
                  }
                  onKeyDown={(event) => {
                    // Enter adds the domain rather than submitting the form.
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addDomain();
                  }}
                />
                <TextButtonUI
                  size="xs"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  disabled={!draft.domainInput.trim() || !!domainError}
                  onClick={addDomain}
                >
                  Add
                </TextButtonUI>
              </div>
              {domainError && (
                <p id={`${domainId}-error`} className={ERROR_CLASS}>
                  {domainError}
                </p>
              )}
              <p id={`${domainId}-hint`} className={HINT_CLASS}>
                Mail counts only when its sender passes DMARC, SPF or DKIM for
                one of these domains. Mail from other domains is recorded as
                ignored.
              </p>
            </div>
          </SettingsRow>
        </>
      )}
    </IntakeSettingsSection>
  );
}

/** A time in the settings, in the viewer's own clock. */
function formatSettingsTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A write-only secret: never shown, kept when left empty. It saves once it
 * is complete, on leaving the field or Enter, never part-typed.
 */
function SecretField({
  label,
  saved,
  value,
  placeholder,
  onChange,
  onCommit,
}: {
  label: string;
  saved: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={id} className={ROW_LABEL_CLASS}>
          {label}
        </label>
        {saved && !value && <SavedMark />}
      </div>
      <SettingsTextInput
        id={id}
        type="password"
        // Not a sign-in: keep the browser from filling a saved password.
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        placeholder={saved ? "Paste a new one to replace it" : placeholder}
        aria-describedby={saved ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onCommit();
        }}
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
  onCommitSecret,
}: {
  settings: IntakeAutomationSettings["slack"];
  draft: IntakeAutomationDraft;
  onChange: Change;
  /** A typed secret is complete and may be saved. */
  onCommitSecret: (secret: "signingSecret" | "botToken") => void;
}) {
  return (
    <IntakeSettingsSection
      title="Slack"
      description="People write @MikeGC in Slack to send a message, or the thread it's in, to Legal. MikeGC asks for missing details, posts a lawyer's questions and replies with the resolution in the same thread."
      steps={[
        "Create a Slack app called MikeGC from the manifest in the setup guide and install it to your workspace.",
        "Turn Slack on, then paste the app's Signing Secret and Bot User OAuth Token below.",
        "In the app's Event Subscriptions, paste the Events Request URL and subscribe to the app_mention, message.channels and message.groups bot events.",
        "Invite @MikeGC to the channels people ask Legal in.",
      ]}
    >
      <ToggleRow
        label="Record requests from Slack"
        description={
          draft.slackEnabled && !settings.configured
            ? "Save the Signing Secret and Bot User OAuth Token to finish turning Slack on."
            : undefined
        }
        checked={draft.slackEnabled}
        onChange={(slackEnabled) => onChange({ slackEnabled })}
      />
      {/* Its setup is shown only while Slack is on. */}
      {draft.slackEnabled && (
        <>
          <SettingsRow layout="stacked">
            <CopyValue
              label="Events Request URL"
              name="Events Request URL"
              value={settings.events_url}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <SecretField
              label="Signing Secret"
              saved={settings.configured}
              value={draft.signingSecret}
              placeholder="Paste the app's Signing Secret"
              onChange={(signingSecret) => onChange({ signingSecret })}
              onCommit={() => onCommitSecret("signingSecret")}
            />
            <SecretField
              label="Bot User OAuth Token"
              saved={settings.configured}
              value={draft.botToken}
              placeholder="xoxb-…"
              onChange={(botToken) => onChange({ botToken })}
              onCommit={() => onCommitSecret("botToken")}
            />
            {settings.configured &&
              (settings.team_name || settings.team_id) && (
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
            {settings.configured && settings.missing_scopes.length > 0 && (
              <SettingsNotice>
                <p className="font-medium">
                  Reinstall the Slack app to send documents.
                </p>
                <p>
                  Its token lacks {settings.missing_scopes.join(", ")}. MikeGC
                  still records requests and posts text, but can&apos;t send
                  documents or post under a lawyer&apos;s name. Add the scopes
                  from the manifest in the setup guide under OAuth &amp;
                  Permissions, reinstall the app, then paste its new Bot User
                  OAuth Token here.
                </p>
              </SettingsNotice>
            )}
            {settings.configured && !settings.message_events_seen && (
              <SettingsNotice>
                <p>
                  MikeGC hasn&apos;t received a thread message yet. Subscribe
                  the app to the message.channels and message.groups bot events
                  so requesters&apos; answers reach their request.
                </p>
              </SettingsNotice>
            )}
          </SettingsRow>
        </>
      )}
    </IntakeSettingsSection>
  );
}

/**
 * Teams: the organization's own Azure Bot, registered once by its Microsoft
 * 365 admin, posts each @MikeGC mention and thread reply to its events URL.
 * The app's client secret is write-only; its IDs save once typed in full.
 */
export function IntakeTeamsSection({
  settings,
  draft,
  onChange,
  onCommit,
}: {
  settings: IntakeAutomationSettings["teams"];
  draft: IntakeAutomationDraft;
  onChange: Change;
  /** A typed ID or secret is complete and may be saved. */
  onCommit: (field: "teamsAppId" | "teamsTenantId" | "teamsSecret") => void;
}) {
  return (
    <IntakeSettingsSection
      title="Teams"
      description="People write @MikeGC in a Teams channel to send a message, or the thread it's in, to Legal. MikeGC asks for missing details, posts a lawyer's questions and replies with the resolution in the same thread."
      steps={[
        "In Microsoft Entra ID, register a single-tenant app and create a client secret.",
        "Create an Azure Bot for that app ID, set its messaging endpoint to the Teams events URL below, and turn on the Microsoft Teams channel.",
        "Upload the Teams app package built from the manifest in the setup guide to your app catalog, then add it to the teams whose channels ask Legal. A team owner consents to it reading channel messages.",
        "For documents, grant the app Microsoft Graph Sites.Selected for those teams' sites (or Files.ReadWrite.All) with admin consent.",
        "Turn Teams on and enter the app ID, tenant ID and client secret below.",
      ]}
    >
      <ToggleRow
        label="Record requests from Teams"
        description={
          draft.teamsEnabled && !settings.configured
            ? "Save the app ID, tenant ID and client secret to finish turning Teams on."
            : undefined
        }
        checked={draft.teamsEnabled}
        onChange={(teamsEnabled) => onChange({ teamsEnabled })}
      />
      {/* Its setup is shown only while Teams is on. */}
      {draft.teamsEnabled && (
        <>
          <SettingsRow layout="stacked">
            <CopyValue
              label="Teams events URL"
              name="Teams events URL"
              value={settings.events_url}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <TextField
              label="App ID"
              value={draft.teamsAppId}
              placeholder="The Entra app's Application (client) ID"
              maxLength={100}
              onChange={(teamsAppId) => onChange({ teamsAppId })}
              onCommit={() => onCommit("teamsAppId")}
            />
            <TextField
              label="Tenant ID"
              value={draft.teamsTenantId}
              placeholder="Your Microsoft 365 tenant ID"
              maxLength={100}
              onChange={(teamsTenantId) => onChange({ teamsTenantId })}
              onCommit={() => onCommit("teamsTenantId")}
            />
            <SecretField
              label="Client secret"
              saved={settings.configured}
              value={draft.teamsSecret}
              placeholder="The Entra app's client secret value"
              onChange={(teamsSecret) => onChange({ teamsSecret })}
              onCommit={() => onCommit("teamsSecret")}
            />
            {settings.configured && (
              <div>
                <p className={LABEL_CLASS}>Document access</p>
                <p className="text-sm text-gray-900">
                  {settings.files_access === null
                    ? "Not checked yet"
                    : settings.files_access
                      ? "Available"
                      : "Not set up"}
                </p>
                <p className="text-xs text-gray-500">
                  {settings.files_access
                    ? "MikeGC reads files shared in threads and posts documents to the channel's files."
                    : "MikeGC posts text only and names the documents. Grant the app Microsoft Graph access to files to send them."}
                </p>
              </div>
            )}
          </SettingsRow>
        </>
      )}
    </IntakeSettingsSection>
  );
}

/** The catalog's name and provider for a model id, as other pickers show it. */
function modelOption(id: string): ModelOption {
  return (
    [...MODELS, ...SETTINGS_MODELS].find((model) => model.id === id) ?? {
      id,
      label: modelDisplayName(id),
      group: "Other providers",
    }
  );
}

type ModelSettings = IntakeAutomationSettings["models"];

/**
 * Models: the model triage runs with and the one AI preprocessing runs with,
 * each chosen from the models the organization has keys for. Neither runs
 * without one, so each says when it can't, and why.
 */
export function IntakeModelsSection({
  title = "Intake",
  settings,
  draft,
  modelSettingsHref,
  onChange,
}: {
  /** The section's heading, which names the feature the models are for. */
  title?: string;
  settings: ModelSettings;
  draft: IntakeAutomationDraft;
  /** Where the model keys both need are set. */
  modelSettingsHref: string;
  onChange: Change;
}) {
  return (
    <IntakeSettingsSection title={title}>
      <ModelRow
        label="Triage"
        description="Writes each request’s subject and summary, fills in its details and assigns it by your rules."
        noun="triage"
        value={draft.triageModel}
        saved={settings.triage}
        savedAvailable={settings.triage_available}
        available={settings.available}
        modelSettingsHref={modelSettingsHref}
        onChange={(triageModel) => onChange({ triageModel })}
      />
      <ModelRow
        label="AI preprocessing"
        description="Answers requests and marks up their Word documents, for rules with AI preprocessing on. A stronger model reads documents better."
        noun="preprocessing"
        value={draft.preprocessingModel}
        saved={settings.preprocessing}
        savedAvailable={settings.preprocessing_available}
        available={settings.available}
        modelSettingsHref={modelSettingsHref}
        onChange={(preprocessingModel) => onChange({ preprocessingModel })}
      />
    </IntakeSettingsSection>
  );
}

/** One model to choose, grouped by provider as other model pickers are. */
function ModelRow({
  label,
  description,
  noun,
  value,
  saved,
  savedAvailable,
  available,
  modelSettingsHref,
  onChange,
}: {
  label: string;
  description: string;
  /** What doesn't run without it, as the notices name it. */
  noun: "triage" | "preprocessing";
  value: string | null;
  saved: string | null;
  savedAvailable: boolean;
  available: string[];
  modelSettingsHref: string;
  onChange: (model: string | null) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const options = available.map(modelOption);
  const groups = orderedModelGroups(options).map((group) => ({
    group,
    items: options.filter((option) => option.group === group),
  }));
  // The saved model has lost its key; a model just chosen is checked on save.
  const keyGone = !!value && value === saved && !savedAvailable;
  const noKeys = !available.length;
  const notice = noKeys
    ? "No model has an API key."
    : keyGone
      ? "This model has no API key."
      : !value
        ? `Choose a model for ${noun} to run.`
        : null;
  return (
    <SettingsRow layout="stacked">
      <div className="min-w-0 space-y-1">
        <p id={labelId} className={ROW_LABEL_CLASS}>
          {label}
        </p>
        <p id={descriptionId} className={ROW_DESCRIPTION_CLASS}>
          {description}
        </p>
      </div>
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            type="button"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            // Nothing to choose until a model has a key.
            disabled={noKeys}
            className={cn(
              "flex h-9 items-center justify-between gap-2 text-left hover:bg-gray-200/70",
              SETTINGS_CONTROL_CLASS,
            )}
          >
            <span
              className={cn(
                "min-w-0 truncate",
                value ? "text-gray-900" : "text-gray-500",
              )}
            >
              {value ? modelOption(value).label : "No model"}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-gray-500"
            />
          </button>
        </DropdownTrigger>
        <DropdownContent
          align="start"
          className="max-h-80 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
        >
          <DropdownRadioGroup
            value={value ?? ""}
            onValueChange={(next) => {
              if (next !== (value ?? "")) onChange(next || null);
            }}
          >
            {groups.map(({ group, items }, index) => (
              <div key={group}>
                {index > 0 && <DropdownSeparator />}
                <DropdownLabel>{group}</DropdownLabel>
                {items.map((option) => (
                  <DropdownRadioItem key={option.id} value={option.id}>
                    {option.label}
                  </DropdownRadioItem>
                ))}
              </div>
            ))}
            {value && (
              <>
                <DropdownSeparator />
                <DropdownRadioItem value="">
                  <span className="min-w-0">
                    No model
                    <span className="block text-gray-500">
                      {noun === "triage"
                        ? "Triage doesn’t run"
                        : "Preprocessing doesn’t run"}
                    </span>
                  </span>
                </DropdownRadioItem>
              </>
            )}
          </DropdownRadioGroup>
        </DropdownContent>
      </Dropdown>
      {notice && (
        <TextSlabUI className="flex items-start gap-2 text-xs text-gray-700">
          <Info
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500"
          />
          <p>
            {notice}
            {(noKeys || keyGone) && (
              <>
                {" "}
                <Link
                  href={modelSettingsHref}
                  className={textButtonUIClassName({
                    size: "xs",
                    className:
                      "inline px-0 text-xs text-blue-600 underline hover:text-blue-700",
                  })}
                >
                  Add one in Bring Your Own Keys
                </Link>
              </>
            )}
          </p>
        </TextSlabUI>
      )}
    </SettingsRow>
  );
}

/**
 * Triage rules: who each request goes to, on a table page of their own, and
 * whether MikeGC asks requesters for what it is missing.
 */
export function IntakeTriageRulesSection({
  rulesHref,
  modelsHref,
  draft,
  onChange,
}: {
  rulesHref: string;
  /** Model Preferences, where triage's and preprocessing's models are chosen. */
  modelsHref: string;
  draft?: IntakeAutomationDraft;
  onChange?: Change;
}) {
  return (
    <IntakeSettingsSection title="Triage rules">
      <SettingsRow>
        <div className="min-w-0">
          <p className={ROW_LABEL_CLASS}>Rules</p>
          <p className={cn(ROW_DESCRIPTION_CLASS, "mt-1")}>
            Who each request goes to, and whether MikeGC preprocesses it. Triage
            and preprocessing use the models chosen in{" "}
            <Link
              href={modelsHref}
              className={textButtonUIClassName({
                size: "xs",
                className:
                  "inline px-0 text-sm text-blue-600 underline hover:text-blue-700",
              })}
            >
              Model Preferences
            </Link>
            .
          </p>
        </div>
        <Link
          href={rulesHref}
          aria-label="Edit rules"
          className={pillButtonUIClassName({
            tone: "blue",
            size: "sm",
            className: "shrink-0",
          })}
        >
          Edit
        </Link>
      </SettingsRow>
      {draft && onChange && (
        <ToggleRow
          label="Ask requesters for missing details"
          description="Before Legal starts, MikeGC asks in the request's thread for what it needs to choose a rule, then for what the rule's playbook or workflow needs. It asks at most two rounds of questions, and stops once a lawyer acts on the request."
          checked={draft.clarifyEnabled}
          onChange={(clarifyEnabled) => onChange({ clarifyEnabled })}
        />
      )}
    </IntakeSettingsSection>
  );
}
