"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, Copy, Info, X } from "lucide-react";
import type {
  IntakeAutomationSettings,
  IntakeEmailWebhook,
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
    <IntakeSettingsSection
      title="Email"
      description="Forward a shared address, such as legal-intake@company.com, and MikeGC records each message sent to it as a request."
      steps={[
        "Turn email on, generate the webhook URL below and copy it.",
        "In Postmark, open your server's Inbound stream and paste it as the Webhook URL.",
        "Forward your intake address to the stream's inbound address.",
        "Add the domains to accept mail from. Until one is added, no mail is recorded.",
      ]}
    >
      <ToggleRow
        label="Record requests from email"
        description={
          draft.emailEnabled && !settings.configured
            ? "Generate the webhook URL to finish turning email on."
            : undefined
        }
        checked={draft.emailEnabled}
        onChange={(emailEnabled) => onChange({ emailEnabled })}
      />
      {/* Its setup is shown only while email is on. */}
      {draft.emailEnabled && (
        <>
          <SettingsRow layout="stacked">
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-sm text-gray-700 [overflow-wrap:anywhere]">
                {!settings.configured
                  ? "No webhook URL yet."
                  : settings.token_hint
                    ? `Webhook URL ending …${settings.token_hint}`
                    : "A webhook URL is set."}
              </p>
              <PillButtonUI
                tone="white"
                size="sm"
                className="shrink-0"
                // The visible word starts the name, which says what it makes.
                aria-label={
                  settings.configured
                    ? "Replace webhook URL"
                    : "Generate webhook URL"
                }
                loading={generating}
                onClick={onGenerate}
              >
                {settings.configured ? "Replace" : "Generate"}
              </PillButtonUI>
            </div>
            {webhook && (
              <CopyValue
                label="Webhook URL"
                name="webhook URL"
                value={webhook.webhook_url}
              >
                <p role="status" className={HINT_CLASS}>
                  Copy it now: MikeGC won&apos;t show it again.
                </p>
              </CopyValue>
            )}
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
                  aria-describedby={
                    domainError ? `${domainId}-error` : undefined
                  }
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
            </div>
          </SettingsRow>
        </>
      )}
    </IntakeSettingsSection>
  );
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
      description="People write @MikeGC in Slack to send a message, or the thread it's in, to Legal."
      steps={[
        "Create a Slack app called MikeGC and install it to your workspace.",
        "Turn Slack on, then paste the app's Signing Secret and Bot User OAuth Token below.",
        "In the app's Event Subscriptions, paste the Events Request URL, subscribe to the app_mention bot event, then invite @MikeGC to your channels.",
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

/** Triage rules: who each request goes to, on a table page of their own. */
export function IntakeTriageRulesSection({
  rulesHref,
  modelsHref,
}: {
  rulesHref: string;
  /** Model Preferences, where triage's and preprocessing's models are chosen. */
  modelsHref: string;
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
    </IntakeSettingsSection>
  );
}
