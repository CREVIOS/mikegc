"use client";

import { useEffect, useRef, useState } from "react";
import type {
  IntakeAutomationSettings,
  IntakeEmailWebhook,
} from "@mike/contracts";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import {
  generateIntakeEmailWebhook,
  getIntakeAutomation,
} from "@/app/lib/mikeApi";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeAutomationDraft,
  type IntakeAutomationDraft,
} from "./intakeAutomation";
import { intakeModelsHref, intakeRulesHref } from "./intakeQuery";
import {
  IntakeSaveStatus,
  useIntakeAutomationAutosave,
} from "./useIntakeAutomationAutosave";
import {
  IntakeEmailSection,
  IntakeSlackSection,
  IntakeTriageRulesSection,
} from "./IntakeSettingsSections";

/** The sections sit apart, as on any Settings page. */
const SECTION_STACK_CLASS = "space-y-8";

type Secret = "signingSecret" | "botToken";

type Loaded = { settings: IntakeAutomationSettings };

/**
 * How MikeGC records requests by itself: from email and from Slack, filled in
 * by AI triage, as the Intake section of the workspace's settings. Every
 * change saves by itself, sending only what changed: switches and lists at
 * once, text once typing pauses, and a secret once it is complete. A failed
 * save keeps typed text on screen and turns a switch back.
 */
export function IntakeSettings({ orgId }: { orgId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<IntakeAutomationDraft | null>(null);
  const [failure, setFailure] = useState<
    { forbidden: true } | { forbidden: false; message: string } | null
  >(null);
  const [reload, setReload] = useState(0);
  // A typed secret saves only once committed, never part-typed.
  const [committed, setCommitted] = useState<Record<Secret, boolean>>({
    signingSecret: false,
    botToken: false,
  });
  const [generating, setGenerating] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  // Shown for this visit only: the API returns the URL just once.
  const [webhook, setWebhook] = useState<IntakeEmailWebhook | null>(null);

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
    // Typing in a secret again waits for it to be complete again.
    if ("signingSecret" in patch || "botToken" in patch)
      setCommitted((current) => ({
        signingSecret: "signingSecret" in patch ? false : current.signingSecret,
        botToken: "botToken" in patch ? false : current.botToken,
      }));
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const commitSecret = (secret: Secret) =>
    setCommitted((current) => ({ ...current, [secret]: true }));

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

  const generate = async () => {
    setConfirmingReplace(false);
    setGenerating(true);
    try {
      const created = await generateIntakeEmailWebhook(orgId);
      setWebhook(created);
      setLoaded((current) =>
        current
          ? {
              ...current,
              settings: {
                ...current.settings,
                email: {
                  ...current.settings.email,
                  configured: true,
                  token_hint: created.token_hint,
                },
              },
            }
          : current,
      );
    } catch (error) {
      notifyError(error, {
        action: "generate the webhook URL",
        // Retry asks again before replacing a URL in use.
        onRetry: () => startGenerateRef.current(),
      });
    } finally {
      setGenerating(false);
    }
  };
  // Replacing a URL Postmark is using stops it working, so that asks first.
  const startGenerate = () => {
    if (generating) return;
    if (loaded?.settings.email.configured) setConfirmingReplace(true);
    else void generate();
  };
  const startGenerateRef = useRef<() => void>(() => {});
  useAssignLatest(startGenerateRef, startGenerate);

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
          webhook={webhook}
          generating={generating}
          onChange={change}
          onGenerate={startGenerate}
        />
        <IntakeSlackSection
          settings={loaded.settings.slack}
          draft={draft}
          onChange={change}
          onCommitSecret={commitSecret}
        />
        <IntakeTriageRulesSection
          rulesHref={intakeRulesHref(orgId)}
          modelsHref={intakeModelsHref(orgId)}
        />
      </form>
      <ConfirmPopup
        open={confirmingReplace}
        title="Replace the webhook URL?"
        message="The current URL stops working at once. Paste the new one into Postmark to keep recording email."
        confirmLabel="Replace URL"
        cancelLabel="Keep current URL"
        onCancel={() => setConfirmingReplace(false)}
        onConfirm={() => void generate()}
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
