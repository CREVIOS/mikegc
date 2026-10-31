"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  IntakeDetails,
  IntakeMember,
  IntakeReceipt,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
  getIntakeMembers,
  submitIntakeRequest,
  uploadIntakeDocuments,
} from "@/app/lib/mikeApi";
import { notifyPartialFailure } from "@/app/lib/userFacingError";
import { discardIntakeDraft } from "@/app/lib/intakeMemory";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { FormTextInput } from "@/app/components/ui/form-field";
import { cn } from "@/app/lib/utils";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DetailColumns } from "./IntakeDetail";
import {
  AssigneeField,
  FIELD_CLASS,
  INTAKE_TEXTAREA_CLASS,
  LABEL_CLASS,
  TargetDateField,
} from "./IntakeDetailsPanel";
import { IntakeDocumentDropZone } from "./IntakeDocumentDropZone";
import { useIntakeDraft, useIntakeMemory } from "./useIntakeMemory";
import {
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";
import {
  intakeTimezones,
  isIntakeOverdue,
  isKnownTimezone,
} from "./intakeLabels";

const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** The new-request page for the current organization workspace. */
export function IntakeNewRequestPage() {
  const { accountId, activeOrganization } = useWorkspace();
  const router = useRouter();
  if (!accountId || !activeOrganization)
    return (
      <EmptyState
        title="Intake"
        description="Switch to an organization workspace to record requests."
      />
    );
  const orgId = activeOrganization.id;
  return (
    <IntakeNewRequest
      key={`${accountId}:${orgId}`}
      orgId={orgId}
      onClose={() => router.push("/intake")}
      onSaved={(id) => router.replace(`/intake/${id}?org=${orgId}`)}
    />
  );
}

/**
 * Records a request for a named business requester, laid out like the
 * request page: the subject as the title, the request beside its details. The draft lives in intake
 * memory, so it survives navigation, and an uncertain save is replayed with
 * the same IDs until its outcome is known. Details are edited afterwards on
 * the request page.
 */
export function IntakeNewRequest({
  orgId,
  onClose,
  onSaved,
}: {
  orgId: string;
  onClose: () => void;
  onSaved: (requestId: string) => void;
}) {
  const { accountId } = useWorkspace();
  const memory = useIntakeMemory(orgId, "new-request");
  const [subject, setSubject] = useIntakeDraft(memory, "subject", "");
  const [description, setDescription] = useIntakeDraft(
    memory,
    "description",
    "",
  );
  const [requesterName, setRequesterName] = useIntakeDraft(
    memory,
    "requesterName",
    "",
  );
  const [requesterEmail, setRequesterEmail] = useIntakeDraft(
    memory,
    "requesterEmail",
    "",
  );
  const [date, setDate] = useIntakeDraft(memory, "date", "");
  const [timezone, setTimezone] = useIntakeDraft(
    memory,
    "timezone",
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  // New requests are assigned to their creator unless someone else is chosen.
  const [assigneeId, setAssigneeId] = useIntakeDraft<string | null>(
    memory,
    "assigneeId",
    accountId ?? null,
  );
  const [members, setMembers] = useState<IntakeMember[]>([]);
  useEffect(() => {
    let current = true;
    // Without the list, the field still shows the current choice.
    getIntakeMembers(orgId).then(
      (list) => current && setMembers(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [orgId]);
  const [files, setFiles] = useIntakeDraft<File[]>(memory, "files", []);
  const [dirty, setDirty] = useIntakeDraft(memory, "dirty", false);
  const [uploading, setUploading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * Contract review documents upload once the request exists. A failure then
   * must not read as a failed request: the request is saved either way.
   */
  async function uploadDocuments(requestId: string, pending: File[]) {
    setUploading(true);
    const failed = await uploadIntakeDocuments(
      orgId,
      requestId,
      pending.map((file) => ({ file })),
    ).then(
      (outcomes) =>
        outcomes.filter((outcome) => outcome.status !== "completed").length,
      () => pending.length,
    );
    if (failed)
      notifyPartialFailure(
        failed === pending.length
          ? "The request was saved, but its documents couldn't be uploaded. Add them from the request."
          : `The request was saved, but ${failed} of ${pending.length} documents couldn't be uploaded. Add them from the request.`,
        { action: "upload the documents" },
      );
    if (mounted.current) setUploading(false);
  }
  const operation = useIntakeOperation(
    (receipt: IntakeReceipt) => {
      const requestId = receipt.request_id;
      if (!requestId) return;
      const pending = files;
      if (!pending.length) {
        discardIntakeDraft(memory);
        onSaved(requestId);
        return;
      }
      void uploadDocuments(requestId, pending).then(() => {
        // Someone who left mid-upload is not pulled back to the request.
        // Read before discarding: the draft also holds the open dialog.
        const stillOpen = mounted.current;
        discardIntakeDraft(memory);
        if (stillOpen) onSaved(requestId);
      });
    },
    undefined,
    memory,
  );
  const locked = operation.locked || uploading;
  const draftGuard = useIntakeDraftWarning(dirty || locked);
  const timezones = useMemo(() => intakeTimezones(), []);
  const ids = {
    documents: useId(),
    description: useId(),
    name: useId(),
    email: useId(),
    date: useId(),
    timezone: useId(),
    timezones: useId(),
  };
  const emailInvalid =
    !!requesterEmail.trim() && !EMAIL.test(requesterEmail.trim());
  const timezoneInvalid =
    !!date && !!timezone.trim() && !isKnownTimezone(timezone.trim());
  const complete =
    !!subject.trim() &&
    !!description.trim() &&
    !!requesterName.trim() &&
    !emailInvalid &&
    (!date || (!!timezone.trim() && !timezoneInvalid));
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setDirty(true);
      set(value);
    };

  function close() {
    if (locked) return;
    draftGuard.requestDiscard(() => {
      if (discardIntakeDraft(memory)) onClose();
    });
  }

  function submit() {
    if (!complete || locked) return;
    const details: IntakeDetails = {
      subject,
      description,
      requester_name: requesterName.trim(),
      requester_email: requesterEmail.trim() || null,
      // The team field is hidden for now; requests are recorded without one.
      requester_team: null,
      requested_by_date: date || null,
      timezone: date ? timezone.trim() : null,
    };
    const body = {
      ...details,
      id: crypto.randomUUID(),
      command_id: crypto.randomUUID(),
      assignee_id: assigneeId,
    };
    void operation.execute(async () => {
      const receipt = await submitIntakeRequest(orgId, body);
      if (receipt.request_id !== body.id)
        throw new Error("Mismatched intake receipt");
      return receipt;
    }, "record the request");
  }

  const savingLabel = uploading ? "Uploading documents…" : "Creating…";
  const overdue =
    !!date &&
    isIntakeOverdue({
      state: "submitted",
      requested_by_date: date,
      timezone: timezone.trim() || null,
    });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        breadcrumbs={[
          { label: "Intake", onClick: close, title: "Back to Intake" },
          { label: "New request" },
        ]}
      />
      <form
        className="@container flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DetailColumns
          title={
            <FormTextInput
              variant="minimal"
              aria-label="Subject"
              placeholder="Subject"
              maxLength={200}
              value={subject}
              disabled={locked}
              autoFocus
              onChange={(event) => change(setSubject)(event.target.value)}
              className="font-medium text-gray-900"
            />
          }
          details={
            <div className="space-y-4 p-4">
              <fieldset className="space-y-4">
                <legend className="sr-only">Requester</legend>
                <div>
                  <label htmlFor={ids.name} className={LABEL_CLASS}>
                    Requester
                  </label>
                  <input
                    id={ids.name}
                    placeholder="Who asked for this"
                    maxLength={200}
                    autoComplete="off"
                    value={requesterName}
                    disabled={locked}
                    onChange={(event) =>
                      change(setRequesterName)(event.target.value)
                    }
                    className={FIELD_CLASS}
                  />
                </div>
                <div>
                  <label htmlFor={ids.email} className={LABEL_CLASS}>
                    Requester email
                  </label>
                  <input
                    id={ids.email}
                    type="email"
                    placeholder="Optional"
                    maxLength={320}
                    autoComplete="off"
                    value={requesterEmail}
                    aria-invalid={emailInvalid}
                    aria-describedby={
                      emailInvalid ? `${ids.email}-error` : undefined
                    }
                    disabled={locked}
                    onChange={(event) =>
                      change(setRequesterEmail)(event.target.value)
                    }
                    className={FIELD_CLASS}
                  />
                  {emailInvalid && (
                    <p
                      id={`${ids.email}-error`}
                      className="mt-1 text-xs text-red-600"
                    >
                      Enter an email address like name@company.com.
                    </p>
                  )}
                </div>
              </fieldset>
              <TargetDateField
                value={date || null}
                overdue={overdue}
                onSave={(next) => change(setDate)(next ?? "")}
              />
              {date && (
                <div>
                  <label htmlFor={ids.timezone} className={LABEL_CLASS}>
                    Timezone
                  </label>
                  <input
                    id={ids.timezone}
                    list={ids.timezones}
                    autoComplete="off"
                    value={timezone}
                    aria-invalid={timezoneInvalid}
                    aria-describedby={
                      timezoneInvalid ? `${ids.timezone}-error` : undefined
                    }
                    disabled={locked}
                    onChange={(event) =>
                      change(setTimezone)(event.target.value)
                    }
                    className={FIELD_CLASS}
                  />
                  <datalist id={ids.timezones}>
                    {timezones.map((zone) => (
                      <option key={zone} value={zone} />
                    ))}
                  </datalist>
                  {timezoneInvalid && (
                    <p
                      id={`${ids.timezone}-error`}
                      className="mt-1 text-xs text-red-600"
                    >
                      Choose a timezone from the list, such as Europe/London.
                    </p>
                  )}
                </div>
              )}
              <AssigneeField
                assigneeId={assigneeId}
                assigneeName={null}
                members={members}
                accountId={accountId ?? null}
                disabled={locked}
                onChange={change(setAssigneeId)}
              />
            </div>
          }
        >
          <GlassCardUI>
            <div className="divide-y divide-gray-100">
              <section className="space-y-2 p-5">
                <label
                  htmlFor={ids.description}
                  className="block text-sm font-medium text-gray-900"
                >
                  Request
                </label>
                <div className="rounded-lg bg-gray-100 transition-shadow focus-within:ring-2 focus-within:ring-gray-300/45">
                  <textarea
                    id={ids.description}
                    rows={5}
                    maxLength={20000}
                    placeholder="The question or request, as it came in"
                    value={description}
                    disabled={locked}
                    onChange={(event) =>
                      change(setDescription)(event.target.value)
                    }
                    className={cn(
                      INTAKE_TEXTAREA_CLASS,
                      "min-h-48 bg-transparent focus:border-transparent focus:ring-0",
                    )}
                  />
                </div>
              </section>
              <section className="space-y-2 p-5">
                <p
                  id={ids.documents}
                  className="text-sm font-medium text-gray-900"
                >
                  Documents
                </p>
                <IntakeDocumentDropZone
                  files={files}
                  labelledBy={ids.documents}
                  disabled={locked}
                  onAdd={(added) => change(setFiles)([...files, ...added])}
                  onRemove={(index) =>
                    change(setFiles)(files.filter((_, i) => i !== index))
                  }
                />
              </section>
            </div>
          </GlassCardUI>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {operation.uncertain && (
              <p role="status" className="mr-auto text-xs text-gray-500">
                Checking whether it was saved.
              </p>
            )}
            {operation.uncertain ? (
              <button
                type="button"
                disabled={operation.busy}
                onClick={() => void operation.execute()}
                className="rounded-md px-2 text-sm text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:text-gray-300"
              >
                Check again
              </button>
            ) : (
              <button
                type="button"
                disabled={locked}
                onClick={close}
                className="rounded-md px-2 text-sm text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:text-gray-300"
              >
                Cancel
              </button>
            )}
            <PillButtonUI
              tone="blue"
              size="sm"
              type="submit"
              disabled={!complete || locked}
              loading={operation.busy || uploading}
            >
              {operation.busy || uploading ? savingLabel : "Create request"}
            </PillButtonUI>
          </div>
        </DetailColumns>
      </form>
      {draftGuard.discardPopup}
    </div>
  );
}
