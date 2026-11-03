"use client";

import { useId, useState, type ReactNode } from "react";
import { Hash, Loader2, Mail, MessagesSquare, X } from "lucide-react";
import type {
  IntakeAutomationSettings,
  IntakeAutomationUpdate,
  IntakeMailProvider,
} from "@mike/contracts";
import { Modal } from "@/app/components/modals/Modal";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import {
  connectIntakeMailbox,
  disconnectIntakeMailbox,
  sendIntakeMailboxTest,
  updateIntakeAutomation,
} from "@/app/lib/mikeApi";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { notifySuccess } from "@/shared/lib/errorNotifier";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
  intakeAutomationChanges,
  intakeAutomationDraft,
  intakeDomainInputError,
  normalizeIntakeDomain,
  type IntakeAutomationDraft,
} from "./intakeAutomation";
import {
  INTAKE_CHANNEL_GUIDES,
  INTAKE_CHANNEL_NAMES,
  INTAKE_MAIL_PROVIDER_LABELS,
  intakeChannelSummary,
  intakeMailboxConnection,
  intakeMailboxForm,
  intakeMailboxFormProblem,
  type IntakeChannelId,
  type IntakeChannelSummary,
  type IntakeMailboxForm,
} from "./intakeChannels";
import {
  CopyValue,
  ERROR_CLASS,
  HINT_CLASS,
  LABEL_CLASS,
  ROW_DESCRIPTION_CLASS,
  ROW_LABEL_CLASS,
  SecretField,
  SettingsNotice,
  TextField,
  ToggleRow,
} from "./IntakeSettingsFields";

const CHANNELS: IntakeChannelId[] = ["email", "slack", "teams"];
const CHANNEL_ICONS: Record<IntakeChannelId, ReactNode> = {
  email: <Mail className="h-4 w-4" />,
  slack: <Hash className="h-4 w-4" />,
  teams: <MessagesSquare className="h-4 w-4" />,
};

type Change = (patch: Partial<IntakeAutomationDraft>) => void;

/**
 * The channels MikeGC records requests from, as compact cards: each names
 * the channel, says in a line how it stands and whether anything needs
 * attention, and has one button, Set up or Manage, that opens the channel's
 * modal. Everything else, from the on/off switch to its keys, is in the
 * modal, which saves with its own button; closing it discards what wasn't
 * saved.
 */
export function IntakeChannelsSection({
  orgId,
  settings,
  onSettings,
}: {
  orgId: string;
  settings: IntakeAutomationSettings;
  /** What the server has after a modal saved, connected or disconnected. */
  onSettings: (settings: IntakeAutomationSettings) => void;
}) {
  const heading = useId();
  const [open, setOpen] = useState<IntakeChannelId | null>(null);
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <SettingsHeading id={heading}>Channels</SettingsHeading>
      {/* Cards sit side by side once their container has room for three. */}
      <div className="@container">
        <div className="grid gap-3 @[44rem]:grid-cols-3">
          {CHANNELS.map((channel) => (
            <IntakeChannelCard
              key={channel}
              channel={channel}
              summary={intakeChannelSummary(settings, channel)}
              onOpen={() => setOpen(channel)}
            />
          ))}
        </div>
      </div>
      {/* Mounted only while open, so closing drops what wasn't saved and
          returns focus to the card's button. */}
      {open && (
        <IntakeChannelModal
          key={open}
          channel={open}
          orgId={orgId}
          settings={settings}
          onSettings={onSettings}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

/** One channel's card: its name, status, any warning, and Set up or Manage. */
export function IntakeChannelCard({
  channel,
  summary,
  onOpen,
}: {
  channel: IntakeChannelId;
  summary: IntakeChannelSummary;
  onOpen: () => void;
}) {
  const name = INTAKE_CHANNEL_NAMES[channel];
  const heading = useId();
  const action = summary.configured ? "Manage" : "Set up";
  return (
    <GlassCardUI>
      <article
        aria-labelledby={heading}
        className="flex h-full min-w-0 flex-col justify-between gap-3 p-4"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600"
          >
            {CHANNEL_ICONS[channel]}
          </span>
          <div className="min-w-0 space-y-0.5">
            <h3 id={heading} className="text-sm font-medium text-gray-900">
              {name}
            </h3>
            <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">
              {summary.status}
            </p>
            {summary.warning && (
              <p className="text-xs text-amber-700 [overflow-wrap:anywhere]">
                {summary.warning}
              </p>
            )}
          </div>
        </div>
        <PillButtonUI
          tone={summary.configured ? "white" : "black"}
          size="sm"
          className="self-start"
          // The visible word starts the name, which says which channel.
          aria-label={`${action} ${name}`}
          aria-haspopup="dialog"
          onClick={onOpen}
        >
          {action}
        </PillButtonUI>
      </article>
    </GlassCardUI>
  );
}

/** The fields a channel's modal may change; nothing else is ever sent. */
const CHANNEL_FIELDS: Record<IntakeChannelId, (keyof IntakeAutomationUpdate)[]> =
  {
    email: ["email_enabled", "email_allowed_domains", "email_from_name"],
    slack: ["slack_enabled", "slack_signing_secret", "slack_bot_token"],
    teams: [
      "teams_enabled",
      "teams_app_id",
      "teams_tenant_id",
      "teams_client_secret",
    ],
  };

/**
 * What saving a channel's modal sends: its fields that differ from what is
 * saved. A sender domain typed but not yet added goes too, when it is one.
 */
export function intakeChannelChanges(
  channel: IntakeChannelId,
  settings: IntakeAutomationSettings,
  draft: IntakeAutomationDraft,
): IntakeAutomationUpdate {
  const typed = normalizeIntakeDomain(draft.domainInput);
  const withTyped =
    typed && !intakeDomainInputError(draft) && !draft.domains.includes(typed)
      ? { ...draft, domains: [...draft.domains, typed] }
      : draft;
  const all = intakeAutomationChanges(settings, withTyped);
  const changes: IntakeAutomationUpdate = {};
  for (const key of CHANNEL_FIELDS[channel])
    if (all[key] !== undefined)
      Object.assign(changes, { [key]: all[key] });
  return changes;
}

/**
 * A channel's modal: everything about it, saved by the footer's button. The
 * email modal first connects the intake mailbox; once it is connected it
 * manages it.
 */
function IntakeChannelModal({
  channel,
  orgId,
  settings,
  onSettings,
  onClose,
}: {
  channel: IntakeChannelId;
  orgId: string;
  settings: IntakeAutomationSettings;
  onSettings: (settings: IntakeAutomationSettings) => void;
  onClose: () => void;
}) {
  const name = INTAKE_CHANNEL_NAMES[channel];
  const guide = INTAKE_CHANNEL_GUIDES[channel];
  const [draft, setDraft] = useState(() => intakeAutomationDraft(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The email modal's connect form, while it is open.
  const [form, setForm] = useState<IntakeMailboxForm | null>(null);
  const change: Change = (patch) => {
    setError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const pending = intakeChannelChanges(channel, settings, draft);
  const dirty = Object.keys(pending).length > 0;
  const connecting =
    channel === "email" && (!settings.email.provider || !!form);

  function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    updateIntakeAutomation(orgId, pending).then(
      (next) => {
        onSettings(next);
        notifySuccess(`${name} settings saved`);
        onClose();
      },
      (cause) => {
        // The fields are on screen to correct: the problem shows beside them.
        setError(
          describeError(cause, { action: `save the ${name} settings` })
            .message,
        );
        setSaving(false);
      },
    );
  }
  function connect() {
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    connectIntakeMailbox(orgId, intakeMailboxConnection(form)).then(
      (next) => {
        onSettings(next);
        // The modal stays open to finish the setup: domains, name, a test.
        setDraft(intakeAutomationDraft(next));
        setForm(null);
        setSaving(false);
        notifySuccess(`Connected ${next.email.mailbox ?? "the mailbox"}`);
      },
      (cause) => {
        setError(
          describeError(cause, { action: "connect the mailbox" }).message,
        );
        setSaving(false);
      },
    );
  }

  const secretSaved =
    settings.email.provider === "graph" && settings.email.graph.secret_set;
  const formProblem = form ? intakeMailboxFormProblem(form, secretSaved) : null;
  const gmailUnavailable =
    form?.provider === "gmail" && !settings.email.gmail_client_id;
  const primaryAction = connecting
    ? form
      ? {
          label: "Connect",
          icon: saving ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined,
          onClick: connect,
          disabled: saving || !!formProblem || gmailUnavailable,
          title: formProblem ?? undefined,
        }
      : undefined
    : {
        label: "Save",
        icon: saving ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined,
        onClick: save,
        disabled: saving || !dirty,
      };

  return (
    <Modal
      open
      size="md"
      onClose={() => !saving && onClose()}
      // Where it belongs, then the channel, which names the dialog.
      breadcrumbs={["Intake", "Channels", name]}
      footerLeading={
        error ? (
          <p
            role="alert"
            className="min-w-0 text-xs text-red-600 [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        ) : undefined
      }
      primaryAction={primaryAction}
      // Closing discards what wasn't saved; the header's Close does the same.
      cancelAction={{ label: "Cancel", onClick: onClose, disabled: saving }}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-5"
      >
        <p className={ROW_DESCRIPTION_CLASS}>{guide.description}</p>
        {channel === "email" ? (
          <IntakeEmailFields
            orgId={orgId}
            settings={settings.email}
            draft={draft}
            form={form}
            busy={saving}
            onChange={change}
            onForm={(next) => {
              setError(null);
              setForm(next);
            }}
            onSave={save}
            onSettings={(next) => {
              onSettings(next);
              setDraft(intakeAutomationDraft(next));
            }}
          />
        ) : channel === "slack" ? (
          <IntakeSlackFields
            settings={settings.slack}
            draft={draft}
            onChange={change}
            onSave={save}
          />
        ) : (
          <IntakeTeamsFields
            settings={settings.teams}
            draft={draft}
            onChange={change}
            onSave={save}
          />
        )}
        <SetupSteps steps={guide.steps} />
      </div>
    </Modal>
  );
}

/** How to set a channel up, in order, at the end of its modal. */
function SetupSteps({ steps }: { steps: string[] }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-2">
      <h3 id={heading} className={ROW_LABEL_CLASS}>
        How to set it up
      </h3>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-gray-700 marker:text-gray-400">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </section>
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
 * Email: connect the intake mailbox (Microsoft 365 through an Entra app, or
 * Google Workspace through the deployment's service account), then manage
 * it: the switch, its address and how reading it is going, a test email,
 * reconnecting or disconnecting, the sender name and the sender domains.
 */
function IntakeEmailFields({
  orgId,
  settings,
  draft,
  form,
  busy,
  onChange,
  onForm,
  onSave,
  onSettings,
}: {
  orgId: string;
  settings: IntakeAutomationSettings["email"];
  draft: IntakeAutomationDraft;
  form: IntakeMailboxForm | null;
  /** Saving or connecting: the fields wait. */
  busy: boolean;
  onChange: Change;
  onForm: (form: IntakeMailboxForm | null) => void;
  onSave: () => void;
  onSettings: (settings: IntakeAutomationSettings) => void;
}) {
  const provider = settings.provider;
  const [testing, setTesting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const start = (choice: IntakeMailProvider) =>
    onForm(intakeMailboxForm(choice, settings));

  function test() {
    if (testing) return;
    setTesting(true);
    sendIntakeMailboxTest(orgId).then(
      (sent) => {
        setTesting(false);
        notifySuccess(`Test email sent to ${sent.sent_to}`);
      },
      (cause) => {
        setTesting(false);
        notifyError(cause, {
          action: "send the test email",
          onRetry: test,
        });
      },
    );
  }
  function disconnect() {
    setConfirmingDisconnect(false);
    setDisconnecting(true);
    disconnectIntakeMailbox(orgId).then(
      (next) => {
        setDisconnecting(false);
        onSettings(next);
      },
      (cause) => {
        setDisconnecting(false);
        notifyError(cause, {
          action: "disconnect the mailbox",
          // Disconnecting stops email, so Retry asks again first.
          onRetry: () => setConfirmingDisconnect(true),
        });
      },
    );
  }

  if (!provider || form)
    return (
      <div className="space-y-4">
        {settings.needs_reconnect && !provider && (
          <SettingsNotice>
            <p className="font-medium">
              Connect your intake mailbox to keep recording email.
            </p>
            <p>
              MikeGC no longer receives mail through Postmark. Connect the
              mailbox you forwarded from, then remove the forwarding rule.
            </p>
          </SettingsNotice>
        )}
        {form ? (
          <MailboxConnectFields
            form={form}
            settings={settings}
            busy={busy}
            onChange={(patch) => onForm({ ...form, ...patch })}
            onBack={() => onForm(null)}
            backLabel={provider ? "Keep the current connection" : "Choose another"}
          />
        ) : (
          <div className="space-y-2">
            <p className={ROW_LABEL_CLASS}>Where is the intake mailbox?</p>
            <div className="flex flex-wrap items-center gap-2">
              <PillButtonUI tone="white" size="sm" onClick={() => start("graph")}>
                Connect Outlook (Microsoft 365)
              </PillButtonUI>
              <PillButtonUI tone="white" size="sm" onClick={() => start("gmail")}>
                Connect Gmail (Google Workspace)
              </PillButtonUI>
            </div>
          </div>
        )}
      </div>
    );

  return (
    <div className="space-y-6">
      <ToggleRow
        bare
        label="Record requests from email"
        checked={draft.emailEnabled}
        disabled={busy}
        onChange={(emailEnabled) => onChange({ emailEnabled })}
      />
      <div className="space-y-2">
        <div className="min-w-0 space-y-1">
          <p className={ROW_LABEL_CLASS}>Intake address</p>
          <p className="text-sm text-gray-900 [overflow-wrap:anywhere]">
            {settings.mailbox}
          </p>
          <p className="text-xs text-gray-500">
            {INTAKE_MAIL_PROVIDER_LABELS[provider]}
          </p>
          <p className="text-xs text-gray-500">
            {settings.status.last_read_at
              ? `Last read ${formatSettingsTime(settings.status.last_read_at)}`
              : "Not read yet"}
          </p>
          {provider === "graph" && settings.status.subscription_expires_at && (
            <p className="text-xs text-gray-500">
              New-mail notifications renew before{" "}
              {formatSettingsTime(settings.status.subscription_expires_at)}
            </p>
          )}
        </div>
        {settings.status.error && (
          <SettingsNotice tone="error">
            <p>{settings.status.error}</p>
          </SettingsNotice>
        )}
        {confirmingDisconnect ? (
          <div
            role="group"
            aria-label="Disconnect the intake mailbox?"
            className="space-y-2"
          >
            <p className="text-sm text-gray-700">
              Disconnect the intake mailbox? MikeGC stops reading and replying
              from it at once, and mail sent to it is no longer recorded.
              Requests already recorded keep their history.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <PillButtonUI
                tone="white"
                size="sm"
                onClick={() => setConfirmingDisconnect(false)}
              >
                Keep connected
              </PillButtonUI>
              <PillButtonUI tone="danger" size="sm" onClick={disconnect}>
                Disconnect
              </PillButtonUI>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <PillButtonUI
              tone="white"
              size="sm"
              loading={testing}
              disabled={testing || busy || disconnecting}
              onClick={test}
            >
              Send test email
            </PillButtonUI>
            <PillButtonUI
              tone="white"
              size="sm"
              disabled={busy || disconnecting}
              aria-label={`Reconnect ${INTAKE_MAIL_PROVIDER_LABELS[provider]}`}
              onClick={() => start(provider)}
            >
              Reconnect
            </PillButtonUI>
            <PillButtonUI
              tone="danger"
              size="sm"
              loading={disconnecting}
              disabled={busy || disconnecting}
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </PillButtonUI>
          </div>
        )}
      </div>
      <TextField
        label="Sender name"
        value={draft.fromName}
        placeholder="Legal"
        maxLength={100}
        hint={`MikeGC's own emails come from this name at ${settings.mailbox ?? "the intake address"}. A lawyer's message reads "Their name via ${draft.fromName.trim() || "Legal"}".`}
        onChange={(fromName) => onChange({ fromName })}
        onEnter={onSave}
      />
      <SenderDomains draft={draft} onChange={onChange} />
    </div>
  );
}

/** The sender domains mail is accepted from, added one at a time. */
function SenderDomains({
  draft,
  onChange,
}: {
  draft: IntakeAutomationDraft;
  onChange: Change;
}) {
  const id = useId();
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
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        Allowed sender domains
      </label>
      {draft.domains.length > 0 && (
        <ul className="mb-2 space-y-1">
          {draft.domains.map((domain) => (
            <li
              key={domain}
              className="flex min-w-0 items-center justify-between gap-2 text-sm text-gray-900"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{domain}</span>
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
      {/* Add sits inside the field, at its end. */}
      <div className="relative">
        <SettingsTextInput
          id={id}
          className="pr-14"
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          value={draft.domainInput}
          aria-invalid={!!domainError}
          aria-describedby={`${id}-hint${domainError ? ` ${id}-error` : ""}`}
          onChange={(event) => onChange({ domainInput: event.target.value })}
          onKeyDown={(event) => {
            // Enter adds the domain rather than saving.
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
        <p id={`${id}-error`} className={ERROR_CLASS}>
          {domainError}
        </p>
      )}
      <p id={`${id}-hint`} className={HINT_CLASS}>
        Mail counts only when its sender passes DMARC, SPF or DKIM for one of
        these domains. Mail from other domains is recorded as ignored.
      </p>
    </div>
  );
}

/**
 * The intake mailbox's connection: its address and, for Microsoft 365, the
 * Entra app's IDs and write-only secret; for Google Workspace, the client ID
 * to delegate to.
 */
function MailboxConnectFields({
  form,
  settings,
  busy,
  onChange,
  onBack,
  backLabel,
}: {
  form: IntakeMailboxForm;
  settings: IntakeAutomationSettings["email"];
  busy: boolean;
  onChange: (patch: Partial<IntakeMailboxForm>) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const secretSaved =
    settings.provider === "graph" && settings.graph.secret_set;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={ROW_LABEL_CLASS}>
          Connect {INTAKE_MAIL_PROVIDER_LABELS[form.provider]}
        </p>
        <TextButtonUI size="xs" disabled={busy} onClick={onBack}>
          {backLabel}
        </TextButtonUI>
      </div>
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
          <SecretField
            label="Client secret"
            saved={secretSaved}
            value={form.clientSecret}
            placeholder="The Entra app's client secret value"
            onChange={(clientSecret) => onChange({ clientSecret })}
          />
        </>
      ) : !settings.gmail_client_id ? (
        <SettingsNotice>
          <p>
            This deployment has no Google service account, so Gmail can&apos;t
            be connected. Its administrator sets INTAKE_GMAIL_SERVICE_ACCOUNT_KEY
            to the service account&apos;s JSON key.
          </p>
        </SettingsNotice>
      ) : (
        <CopyValue
          label="Service account client ID"
          name="service account client ID"
          value={settings.gmail_client_id}
        >
          <p className={HINT_CLASS}>
            In the Google Admin console, add this client ID under Security, API
            controls, Domain-wide delegation, with the scope
            https://www.googleapis.com/auth/gmail.modify.
          </p>
        </CopyValue>
      )}
    </div>
  );
}

/**
 * Slack: the switch, the events URL to paste into the app, its write-only
 * Signing Secret and Bot User OAuth Token, the workspace they belong to, and
 * what to fix when the app lacks a scope or its message events.
 */
function IntakeSlackFields({
  settings,
  draft,
  onChange,
  onSave,
}: {
  settings: IntakeAutomationSettings["slack"];
  draft: IntakeAutomationDraft;
  onChange: Change;
  onSave: () => void;
}) {
  return (
    <div className="space-y-6">
      <ToggleRow
        bare
        label="Record requests from Slack"
        description={
          draft.slackEnabled && !settings.configured
            ? "Save the Signing Secret and Bot User OAuth Token to finish turning Slack on."
            : undefined
        }
        checked={draft.slackEnabled}
        onChange={(slackEnabled) => onChange({ slackEnabled })}
      />
      <CopyValue
        label="Events Request URL"
        name="Events Request URL"
        value={settings.events_url}
      />
      <SecretField
        label="Signing Secret"
        saved={settings.configured}
        value={draft.signingSecret}
        placeholder="Paste the app's Signing Secret"
        onChange={(signingSecret) => onChange({ signingSecret })}
        onEnter={onSave}
      />
      <SecretField
        label="Bot User OAuth Token"
        saved={settings.configured}
        value={draft.botToken}
        placeholder="xoxb-…"
        onChange={(botToken) => onChange({ botToken })}
        onEnter={onSave}
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
      {settings.configured && settings.missing_scopes.length > 0 && (
        <SettingsNotice>
          <p className="font-medium">Reinstall the Slack app to send documents.</p>
          <p>
            Its token lacks {settings.missing_scopes.join(", ")}. MikeGC still
            records requests and posts text, but can&apos;t send documents or
            post under a lawyer&apos;s name. Add the scopes from the manifest
            in the setup guide under OAuth &amp; Permissions, reinstall the
            app, then paste its new Bot User OAuth Token here.
          </p>
        </SettingsNotice>
      )}
      {settings.configured && !settings.message_events_seen && (
        <SettingsNotice>
          <p>
            MikeGC hasn&apos;t received a thread message yet. Subscribe the app
            to the message.channels and message.groups bot events so
            requesters&apos; answers reach their request.
          </p>
        </SettingsNotice>
      )}
    </div>
  );
}

/**
 * Teams: the switch, the events URL for the Azure Bot, the app's IDs and
 * write-only client secret, and whether MikeGC can send documents.
 */
function IntakeTeamsFields({
  settings,
  draft,
  onChange,
  onSave,
}: {
  settings: IntakeAutomationSettings["teams"];
  draft: IntakeAutomationDraft;
  onChange: Change;
  onSave: () => void;
}) {
  return (
    <div className="space-y-6">
      <ToggleRow
        bare
        label="Record requests from Teams"
        description={
          draft.teamsEnabled && !settings.configured
            ? "Save the app ID, tenant ID and client secret to finish turning Teams on."
            : undefined
        }
        checked={draft.teamsEnabled}
        onChange={(teamsEnabled) => onChange({ teamsEnabled })}
      />
      <CopyValue
        label="Teams events URL"
        name="Teams events URL"
        value={settings.events_url}
      />
      <TextField
        label="App ID"
        value={draft.teamsAppId}
        placeholder="The Entra app's Application (client) ID"
        maxLength={100}
        onChange={(teamsAppId) => onChange({ teamsAppId })}
        onEnter={onSave}
      />
      <TextField
        label="Tenant ID"
        value={draft.teamsTenantId}
        placeholder="Your Microsoft 365 tenant ID"
        maxLength={100}
        onChange={(teamsTenantId) => onChange({ teamsTenantId })}
        onEnter={onSave}
      />
      <SecretField
        label="Client secret"
        saved={settings.configured}
        value={draft.teamsSecret}
        placeholder="The Entra app's client secret value"
        onChange={(teamsSecret) => onChange({ teamsSecret })}
        onEnter={onSave}
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
    </div>
  );
}

/** The cards while the page loads: the heading, then three cards' shapes. */
export function IntakeChannelsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex h-7 items-center">
        <div className="h-3 w-20 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
      </div>
      <div className="@container">
        <div className="grid gap-3 @[44rem]:grid-cols-3">
          {CHANNELS.map((channel) => (
            <GlassCardUI key={channel}>
              <div className="flex flex-col gap-3 p-4">
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-gray-100 motion-reduce:animate-none" />
                  <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                    <div className="h-3 w-16 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
                    <div className="h-3 w-32 max-w-full animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
                  </div>
                </div>
                <div className="h-7 w-20 animate-pulse rounded-full bg-gray-100 motion-reduce:animate-none" />
              </div>
            </GlassCardUI>
          ))}
        </div>
      </div>
    </div>
  );
}
