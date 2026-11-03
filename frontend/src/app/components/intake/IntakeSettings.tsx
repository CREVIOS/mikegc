"use client";

import { useEffect, useState } from "react";
import type {
  IntakeAutomationSettings,
  IntakeMailboxConnection,
  IntakeMailProvider,
} from "@mike/contracts";
import {
  connectIntakeMailbox,
  disconnectIntakeMailbox,
  getIntakeAutomation,
  sendIntakeMailboxTest,
} from "@/app/lib/mikeApi";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { notifySuccess } from "@/shared/lib/errorNotifier";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeAutomationDraft,
  intakeDraftWithEmail,
  NOTHING_COMMITTED,
  type IntakeAutomationDraft,
  type IntakeCommitKey,
  type IntakeCommitted,
} from "./intakeAutomation";
import { intakeModelsHref, intakeRulesHref } from "./intakeQuery";
import {
  IntakeSaveStatus,
  useIntakeAutomationAutosave,
} from "./useIntakeAutomationAutosave";
import {
  IntakeEmailSection,
  IntakeSlackSection,
  IntakeTeamsSection,
  IntakeTriageRulesSection,
  type IntakeMailboxForm,
} from "./IntakeSettingsSections";

/** The sections sit apart, as on any Settings page. */
const SECTION_STACK_CLASS = "space-y-8";

type Loaded = { settings: IntakeAutomationSettings };

/** The connect form for `provider`, starting from what is saved. */
function mailboxForm(
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

/** The connection as the API takes it; an empty secret keeps the saved one. */
function mailboxConnection(form: IntakeMailboxForm): IntakeMailboxConnection {
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
 * How MikeGC records requests by itself: from the intake mailbox, Slack and
 * Teams, filled in by AI triage, as the Intake section of the workspace's
 * settings. Every change saves by itself, sending only what changed:
 * switches and lists at once, text once typing pauses, and a secret or ID
 * once it is complete. A failed save keeps typed text on screen and turns a
 * switch back. Connecting the mailbox is its own step, checked as it saves.
 */
export function IntakeSettings({ orgId }: { orgId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<IntakeAutomationDraft | null>(null);
  const [failure, setFailure] = useState<
    { forbidden: true } | { forbidden: false; message: string } | null
  >(null);
  const [reload, setReload] = useState(0);
  // A typed secret or ID saves only once committed, never part-typed.
  const [committed, setCommitted] =
    useState<IntakeCommitted>(NOTHING_COMMITTED);
  // The mailbox connect form, while it is open.
  const [form, setForm] = useState<IntakeMailboxForm | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true;
    getIntakeAutomation(orgId).then(
      (settings) => {
        if (!active) return;
        setLoaded({ settings });
        setDraft(intakeAutomationDraft(settings));
        setFailure(null);
      },
      (error) => {
        if (!active) return;
        const described = describeError(error, {
          action: "load the intake settings",
        });
        setFailure(
          described.kind === "forbidden"
            ? { forbidden: true }
            : { forbidden: false, message: described.message },
        );
      },
    );
    return () => {
      active = false;
    };
  }, [orgId, reload]);

  const change = (patch: Partial<IntakeAutomationDraft>) => {
    // Typing in a secret or ID again waits for it to be complete again.
    const typed = (Object.keys(NOTHING_COMMITTED) as IntakeCommitKey[]).filter(
      (key) => key in patch,
    );
    if (typed.length)
      setCommitted((current) => {
        const next = { ...current };
        for (const key of typed) next[key] = false;
        return next;
      });
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const commit = (key: IntakeCommitKey) =>
    setCommitted((current) => ({ ...current, [key]: true }));

  const saving = useIntakeAutomationAutosave({
    orgId,
    settings: loaded?.settings ?? null,
    draft,
    committed,
    onSettings: (settings) =>
      setLoaded((current) => (current ? { ...current, settings } : current)),
    onDraft: (next) =>
      setDraft((current) => (current ? next(current) : current)),
  });

  /** Settings the mailbox calls returned: the email fields follow them. */
  const adopt = (settings: IntakeAutomationSettings) => {
    setLoaded((current) => (current ? { ...current, settings } : current));
    setDraft((current) =>
      current ? intakeDraftWithEmail(current, settings) : current,
    );
  };
  const connect = async () => {
    if (!form || connecting) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const settings = await connectIntakeMailbox(
        orgId,
        mailboxConnection(form),
      );
      adopt(settings);
      setForm(null);
      notifySuccess(`Connected ${settings.email.mailbox ?? "the mailbox"}`);
    } catch (error) {
      // The form is being edited: its problem shows under it.
      setConnectError(
        describeError(error, { action: "connect the mailbox" }).message,
      );
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async () => {
    setConfirmingDisconnect(false);
    setDisconnecting(true);
    try {
      adopt(await disconnectIntakeMailbox(orgId));
    } catch (error) {
      notifyError(error, {
        action: "disconnect the mailbox",
        // Disconnecting stops email, so Retry asks again first.
        onRetry: () => setConfirmingDisconnect(true),
      });
    } finally {
      setDisconnecting(false);
    }
  };
  const test = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const sent = await sendIntakeMailboxTest(orgId);
      notifySuccess(`Test email sent to ${sent.sent_to}`);
    } catch (error) {
      notifyError(error, {
        action: "send the test email",
        onRetry: () => void test(),
      });
    } finally {
      setTesting(false);
    }
  };

  if (failure?.forbidden)
    return (
      <EmptyState
        title="Intake"
        description="Only owners and admins can change automated intake."
      />
    );
  if (failure)
    return (
      <EmptyState
        tone="error"
        title="Unable to load the settings"
        description={<span role="alert">{failure.message}</span>}
        action={
          <PillButtonUI
            tone="black"
            size="sm"
            onClick={() => {
              setFailure(null);
              setReload((n) => n + 1);
            }}
          >
            Try again
          </PillButtonUI>
        }
      />
    );
  if (!loaded || !draft) return <IntakeSettingsSkeleton />;
  return (
    <>
      <div aria-live="polite" className="mb-2 flex min-h-4 justify-end text-xs">
        <IntakeSaveStatus state={saving} />
      </div>
      <form
        aria-label="Automated intake"
        noValidate
        // Nothing to submit: every field saves by itself.
        onSubmit={(event) => event.preventDefault()}
        className={SECTION_STACK_CLASS}
      >
        <IntakeEmailSection
          settings={loaded.settings.email}
          draft={draft}
          form={form}
          connecting={connecting}
          connectError={connectError}
          testing={testing || disconnecting}
          onChange={change}
          onStartConnect={(provider) => {
            setConnectError(null);
            setForm(mailboxForm(provider, loaded.settings.email));
          }}
          onFormChange={(patch) => {
            setConnectError(null);
            setForm((current) => (current ? { ...current, ...patch } : current));
          }}
          onConnect={() => void connect()}
          onCancelConnect={() => {
            setConnectError(null);
            setForm(null);
          }}
          onDisconnect={() => setConfirmingDisconnect(true)}
          onTest={() => void test()}
        />
        <IntakeSlackSection
          settings={loaded.settings.slack}
          draft={draft}
          onChange={change}
          onCommitSecret={commit}
        />
        <IntakeTeamsSection
          settings={loaded.settings.teams}
          draft={draft}
          onChange={change}
          onCommit={commit}
        />
        <IntakeTriageRulesSection
          rulesHref={intakeRulesHref(orgId)}
          modelsHref={intakeModelsHref(orgId)}
          draft={draft}
          onChange={change}
        />
      </form>
      <ConfirmPopup
        open={confirmingDisconnect}
        title="Disconnect the intake mailbox?"
        message="MikeGC stops reading and replying from it at once, and mail sent to it is no longer recorded. Requests already recorded keep their history."
        confirmLabel="Disconnect"
        confirmVariant="danger"
        cancelLabel="Keep connected"
        onCancel={() => setConfirmingDisconnect(false)}
        onConfirm={() => void disconnect()}
      />
    </>
  );
}

/** The section while it loads: the save status's line, then Email's heading and its card. */
function IntakeSettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the intake settings">
      <div className="mb-2 min-h-4" />
      <div className="space-y-3">
        <div className="flex h-7 items-center">
          <SkeletonLine className="w-16" />
        </div>
        <GlassCardUI>
          {Array.from({ length: 3 }, (_, row) => (
            <div
              key={row}
              className="flex items-center justify-between gap-4 border-t border-gray-100 p-4 first:border-t-0"
            >
              <SkeletonLine className="w-1/2" />
              {row === 0 && (
                <div className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-gray-100 motion-reduce:animate-none" />
              )}
            </div>
          ))}
        </GlassCardUI>
      </div>
    </div>
  );
}
