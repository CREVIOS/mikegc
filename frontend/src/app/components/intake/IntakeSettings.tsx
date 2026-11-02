"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  IntakeAutomationSettings,
  IntakeEmailWebhook,
  IntakeMember,
} from "@mike/contracts";
import {
  PERSONAL_WORKSPACE,
  useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import {
  generateIntakeEmailWebhook,
  getIntakeAutomation,
  getIntakeMembers,
  updateIntakeAutomation,
} from "@/app/lib/mikeApi";
import {
  describeError,
  notifyError,
  notifySuccess,
} from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeAutomationChanges,
  intakeAutomationDraft,
  intakeDomainInputError,
  intakeTimezoneError,
  type IntakeAutomationDraft,
} from "./intakeAutomation";
import { IntakePageHeader } from "./IntakePageHeader";
import {
  IntakeEmailSection,
  IntakeRecentMessages,
  IntakeSlackSection,
  IntakeTriageSection,
} from "./IntakeSettingsSections";

/** The cards stack 1rem apart, as on the dashboard. */
const CARD_STACK_CLASS = "space-y-4";
/** A form reads best narrower than the dashboard's full width. */
const COLUMN_CLASS = "max-w-3xl";

/** /intake/settings, for the signed-in account's active workspace. */
export function IntakeSettingsPage() {
  const { accountId, workspaceId } = useWorkspace();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <IntakePageHeader page="settings" />
      {accountId && workspaceId ? (
        <IntakeSettings
          key={`${accountId}:${workspaceId}`}
          orgId={workspaceId}
        />
      ) : (
        <EmptyState
          className="px-3 md:px-6.5"
          title="Intake"
          description="Sign in to change automated intake."
        />
      )}
    </div>
  );
}

type Loaded = {
  settings: IntakeAutomationSettings;
  /** Null in Personal, where every request is the owner's. */
  members: IntakeMember[] | null;
};

/** Where an organization's, or a person's own, model keys are set. */
function modelSettingsHref(orgId: string) {
  return orgId === PERSONAL_WORKSPACE
    ? "/settings/byok"
    : `/organizations/${encodeURIComponent(orgId)}/settings/providers`;
}

/**
 * How MikeGC records requests by itself: from email, from Slack, and with or
 * without AI triage. Every change waits for Save, which sends only what
 * changed; a failed save keeps the edits on screen.
 */
export function IntakeSettings({ orgId }: { orgId: string }) {
  const personal = orgId === PERSONAL_WORKSPACE;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<IntakeAutomationDraft | null>(null);
  const [failure, setFailure] = useState<
    { forbidden: true } | { forbidden: false; message: string } | null
  >(null);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  // Shown for this visit only: the API returns the URL just once.
  const [webhook, setWebhook] = useState<IntakeEmailWebhook | null>(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      getIntakeAutomation(orgId),
      personal ? Promise.resolve(null) : getIntakeMembers(orgId),
    ]).then(([settings, members]) => {
      if (!active) return;
      const failed =
        settings.status === "rejected"
          ? settings.reason
          : members.status === "rejected"
            ? members.reason
            : null;
      if (settings.status === "rejected" || members.status === "rejected") {
        const described = describeError(failed, {
          action: "load the intake settings",
        });
        setFailure(
          described.kind === "forbidden" && settings.status === "rejected"
            ? { forbidden: true }
            : { forbidden: false, message: described.message },
        );
        return;
      }
      setLoaded({ settings: settings.value, members: members.value });
      setDraft(intakeAutomationDraft(settings.value));
      setFailure(null);
    });
    return () => {
      active = false;
    };
  }, [orgId, personal, reload]);

  const change = (patch: Partial<IntakeAutomationDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const changes =
    loaded && draft ? intakeAutomationChanges(loaded.settings, draft) : {};
  const dirty = Object.keys(changes).length > 0;
  const timezoneInvalid = !!draft && !!intakeTimezoneError(draft);
  const domainInvalid = !!draft && !!intakeDomainInputError(draft);
  const invalid = timezoneInvalid || domainInvalid;
  const busy = saving || generating;

  const saveRef = useRef<() => void>(() => {});
  const save = async () => {
    if (!loaded || !draft || !dirty || invalid || busy) return;
    setSaving(true);
    try {
      const settings = await updateIntakeAutomation(orgId, changes);
      setLoaded((current) => (current ? { ...current, settings } : current));
      // Saved: the page now shows what the server kept, secrets cleared.
      setDraft(intakeAutomationDraft(settings));
      notifySuccess("Intake settings saved");
    } catch (error) {
      // The edits stay on screen, so Retry sends them again.
      notifyError(error, {
        action: "save the intake settings",
        onRetry: () => saveRef.current(),
      });
    } finally {
      setSaving(false);
    }
  };
  useAssignLatest(saveRef, () => void save());

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
    if (busy) return;
    if (loaded?.settings.email.configured) setConfirmingReplace(true);
    else void generate();
  };
  const startGenerateRef = useRef<() => void>(() => {});
  useAssignLatest(startGenerateRef, startGenerate);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* The same gutters as the header, so the cards line up with it. */}
      <div className="px-3 pb-8 md:px-6.5">
        {failure?.forbidden ? (
          <EmptyState
            title="Automated intake"
            description="Only owners and admins can change automated intake."
          />
        ) : failure ? (
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
        ) : loaded && draft ? (
          <form
            aria-label="Automated intake"
            noValidate
            onSubmit={onSubmit}
            className={COLUMN_CLASS}
          >
            {/* Nothing changes under a save that is being sent. */}
            <fieldset
              disabled={saving}
              className={cn("min-w-0", CARD_STACK_CLASS)}
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
              />
              <IntakeTriageSection
                settings={loaded.settings.triage}
                draft={draft}
                members={loaded.members}
                modelSettingsHref={modelSettingsHref(orgId)}
                onChange={change}
              />
              <IntakeRecentMessages
                orgId={orgId}
                recent={loaded.settings.recent}
              />
            </fieldset>
            <div className="sticky bottom-4 z-10 mt-4 flex justify-end">
              <div
                className={cn(
                  "flex flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-full py-1.5 pl-4 pr-1.5",
                  LIQUID_GLASS_FLOAT_CLASS,
                )}
              >
                <p role="status" className="text-xs text-gray-500">
                  {saving
                    ? "Saving…"
                    : timezoneInvalid
                      ? "Choose a timezone from the list to save."
                      : domainInvalid
                        ? "Correct the sender domain to save."
                        : dirty
                          ? "Unsaved changes"
                          : "All changes saved"}
                </p>
                <PillButtonUI
                  type="submit"
                  tone="black"
                  size="sm"
                  loading={saving}
                  disabled={!dirty || invalid || generating}
                >
                  Save
                </PillButtonUI>
              </div>
            </div>
          </form>
        ) : (
          <IntakeSettingsSkeleton personal={personal} />
        )}
      </div>
      <ConfirmPopup
        open={confirmingReplace}
        title="Replace the webhook URL?"
        message="The current URL stops working at once. Paste the new one into Postmark to keep recording email."
        confirmLabel="Replace URL"
        cancelLabel="Keep current URL"
        onCancel={() => setConfirmingReplace(false)}
        onConfirm={() => void generate()}
      />
    </div>
  );
}

/** The page's layout while it loads: the same cards, with lines for rows. */
function IntakeSettingsSkeleton({ personal }: { personal: boolean }) {
  // Email, Slack, AI triage (with members in an organization), recent
  // messages; the first three open with a switch.
  const cards = [
    { rows: 3, toggle: true },
    { rows: 3, toggle: true },
    { rows: personal ? 2 : 4, toggle: true },
    { rows: 2, toggle: false },
  ];
  return (
    <div
      aria-busy="true"
      aria-label="Loading the intake settings"
      className={cn(COLUMN_CLASS, CARD_STACK_CLASS)}
    >
      {cards.map(({ rows, toggle }, card) => (
        <GlassCardUI key={card}>
          <div className="divide-y divide-gray-100">
            <div className="space-y-2.5 p-5">
              <SkeletonLine className="w-24" />
              <SkeletonLine className="w-3/4" />
            </div>
            {Array.from({ length: rows }, (_, row) => (
              <div
                key={row}
                className="flex items-center justify-between gap-4 p-5"
              >
                <SkeletonLine className="w-1/2" />
                {toggle && row === 0 && (
                  <div
                    aria-hidden="true"
                    className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-gray-100 motion-reduce:animate-none"
                  />
                )}
              </div>
            ))}
          </div>
        </GlassCardUI>
      ))}
    </div>
  );
}
