"use client";

import { useEffect, useState } from "react";
import type { IntakeAutomationSettings } from "@mike/contracts";
import { getIntakeAutomation } from "@/app/lib/mikeApi";
import { describeError } from "@/app/lib/userFacingError";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeAutomationDraft,
  type IntakeAutomationDraft,
} from "./intakeAutomation";
import { intakeDraftWithChannels } from "./intakeChannels";
import { intakeModelsHref, intakeRulesHref } from "./intakeQuery";
import {
  IntakeSaveStatus,
  useIntakeAutomationAutosave,
} from "./useIntakeAutomationAutosave";
import {
  IntakeChannelsSection,
  IntakeChannelsSkeleton,
} from "./IntakeChannelSettings";
import { IntakeTriageRulesSection } from "./IntakeSettingsSections";

/** The sections sit apart, as on any Settings page. */
const SECTION_STACK_CLASS = "space-y-8";

type Loaded = { settings: IntakeAutomationSettings };

/**
 * How MikeGC records requests by itself, as the Intake section of the
 * workspace's settings. The channels it records from (email, Slack and
 * Teams) are cards, each set up or managed in its own modal, which saves
 * with its own button. The triage section below saves by itself, switches
 * at once; a failed save turns a switch back.
 */
export function IntakeSettings({ orgId }: { orgId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<IntakeAutomationDraft | null>(null);
  const [failure, setFailure] = useState<
    { forbidden: true } | { forbidden: false; message: string } | null
  >(null);
  const [reload, setReload] = useState(0);

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

  const change = (patch: Partial<IntakeAutomationDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const saving = useIntakeAutomationAutosave({
    orgId,
    settings: loaded?.settings ?? null,
    draft,
    onSettings: (settings) =>
      setLoaded((current) => (current ? { ...current, settings } : current)),
    onDraft: (next) =>
      setDraft((current) => (current ? next(current) : current)),
  });

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
        // Nothing to submit: each section saves by itself.
        onSubmit={(event) => event.preventDefault()}
        className={SECTION_STACK_CLASS}
      >
        <IntakeChannelsSection
          orgId={orgId}
          settings={loaded.settings}
          onSettings={(settings) => {
            setLoaded((current) => (current ? { ...current, settings } : current));
            // The page's own draft takes the channels as saved, so its
            // autosave never sends an older value back.
            setDraft((current) =>
              current ? intakeDraftWithChannels(current, settings) : current,
            );
          }}
        />
        <IntakeTriageRulesSection
          rulesHref={intakeRulesHref(orgId)}
          modelsHref={intakeModelsHref(orgId)}
          draft={draft}
          onChange={change}
        />
      </form>
    </>
  );
}

/** The page while it loads: the save status's line, then the channel cards. */
function IntakeSettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the intake settings">
      <div className="mb-2 min-h-4" />
      <IntakeChannelsSkeleton />
    </div>
  );
}
