"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useIntakeMemory, useIntakeDraft } from "./useIntakeMemory";
import type {
  IntakeAction,
  IntakeCommand,
  IntakeDetails,
  IntakeDocument,
  IntakeEdit,
  IntakeEvent,
  IntakeMember,
  IntakeMessage,
  IntakeRequest,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useItemWorkspace } from "@/app/hooks/useItemWorkspace";
import {
  commandIntakeRequest,
  editIntakeRequest,
  getIntakeDocuments,
  getIntakeEvents,
  getIntakeMembers,
  getIntakeMessages,
  getIntakeRequest,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { notifySuccess } from "@/shared/lib/errorNotifier";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  SkeletonLine,
  TableEmptyState,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { IntakeSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { RowActions } from "@/app/components/shared/RowActions";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { DropdownItem, DropdownSeparator } from "@/shared/ui/dropdown";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import {
  intakeError,
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";
import { IntakeActorAvatar } from "./IntakeActorAvatar";
import { IntakeDocuments, useIntakeDocumentUpload } from "./IntakeDocuments";
import { IntakeReasonModal } from "./IntakeReasonModal";
import {
  INTAKE_TEXTAREA_CLASS,
  IntakeDescription,
  IntakeDetailsPanel,
  IntakeSubjectInput,
} from "./IntakeDetailsPanel";
import { formatIntakeDateTime } from "./intakeLabels";
import { describeIntakeEvent, describeIntakeMessage } from "./intakeActivity";

/** Every section on the request page is introduced the same way. */
const SECTION_HEADING = "text-sm font-medium text-gray-900";
/** Quiet refreshes when the window regains focus are at most this frequent. */
const FOCUS_REFRESH_MS = 30_000;

/** Scope a deep-linked request to its organization before mounting retained drafts. */
export function IntakeDetail({
  orgId,
  requestId,
}: {
  orgId: string;
  requestId: string;
}) {
  const { accountId, workspaceId } = useWorkspace();
  useItemWorkspace(requestId, orgId);
  if (!accountId || workspaceId !== orgId)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <TableEmptyState>
          <EmptyState
            icon={<IntakeSkeuoIcon />}
            title="Intake"
            description="Open this request in its organization's workspace."
          />
        </TableEmptyState>
      </div>
    );
  return (
    <Detail
      key={`${accountId}:${orgId}:${requestId}`}
      orgId={orgId}
      requestId={requestId}
      accountId={accountId}
    />
  );
}
/** Read the complete note or event history using the API's 100-row pages. */
async function allPages<T>(read: (offset: number) => Promise<T[]>) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read(offset);
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}
type Closing = "resolve" | "cancel";
/** Which retained draft a successful command has consumed. */
type Consumed = "note" | "reason" | null;
/** Show the current request and gate commands on its server-provided capabilities. */
export function Detail({
  orgId,
  requestId,
  accountId,
}: {
  orgId: string;
  requestId: string;
  accountId: string;
}) {
  const router = useRouter();
  const memory = useIntakeMemory(orgId, requestId);
  const [request, setRequest] = useState<IntakeRequest | null>(null);
  const [messages, setMessages] = useState<IntakeMessage[]>([]);
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [documents, setDocuments] = useState<IntakeDocument[]>([]);
  const [members, setMembers] = useState<IntakeMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useIntakeDraft(memory, "note", "");
  const [reason, setReason] = useIntakeDraft(memory, "reason", "");
  const [closing, setClosing] = useIntakeDraft<Closing | null>(
    memory,
    "closing",
    null,
  );
  const [consumes, setConsumes] = useIntakeDraft<Consumed>(
    memory,
    "consumes",
    null,
  );
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    try {
      const r = await getIntakeRequest(orgId, requestId);
      const [m, e, d, roster] = await Promise.all([
        allPages((offset) => getIntakeMessages(orgId, requestId, offset)),
        allPages((offset) => getIntakeEvents(orgId, requestId, offset)),
        getIntakeDocuments(orgId, requestId),
        r.capabilities.assign ? getIntakeMembers(orgId) : Promise.resolve([]),
      ]);
      if (generation !== epoch.current) return;
      setRequest(r);
      setMessages(m);
      setEvents(e);
      setDocuments(d);
      setMembers(roster);
      setError(null);
    } catch (e) {
      if (generation === epoch.current) {
        setRequest(null);
        setMessages([]);
        setEvents([]);
        setDocuments([]);
        setMembers([]);
        setError(intakeError(e, "load the request"));
      }
    }
  }, [orgId, requestId]);
  const invalidate = useCallback(() => {
    epoch.current++;
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh sets state only after its first request resolves
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  // Coming back to the window refreshes in place: the request stays on
  // screen and drafts are untouched.
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    const focus = () => {
      if (Date.now() - lastFocusRefresh.current < FOCUS_REFRESH_MS) return;
      lastFocusRefresh.current = Date.now();
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  // Detail edits replace every field at the request's version, so one made
  // while another change is saving waits for the refreshed request.
  const queuedDetails = useRef<Partial<IntakeDetails> | null>(null);
  const savedVersion = useRef(0);
  // Remounting the sidebar after a rejected change drops unsaved field text.
  const [detailsEpoch, setDetailsEpoch] = useState(0);
  const operation = useIntakeOperation(
    (receipt) => {
      savedVersion.current = receipt.applied_version;
      if (consumes === "note") setNote("");
      if (consumes === "reason") {
        setReason("");
        setClosing(null);
      }
      setConsumes(null);
      void refresh();
    },
    (rejection) => {
      const status =
        rejection && typeof rejection === "object" && "status" in rejection
          ? Number(rejection.status)
          : 0;
      // Hide what this account may no longer read until the reload decides.
      // Other failures refresh in place, keeping any open dialog and draft.
      queuedDetails.current = null;
      setDetailsEpoch((epoch) => epoch + 1);
      if ([401, 403, 404].includes(status)) {
        setRequest(null);
        setMessages([]);
        setEvents([]);
        setDocuments([]);
        setMembers([]);
      }
      void refresh();
    },
    memory,
  );
  useIntakeDraftWarning(!!note || !!reason || operation.locked);
  /** Capture the displayed request version; recovery reuses the same command. */
  function command(
    action: IntakeAction,
    label: string,
    fields: Pick<IntakeCommand, "body" | "assignee_id"> = {},
    consumed: Consumed = null,
  ) {
    if (!request) return;
    const input: IntakeCommand = {
      command_id: crypto.randomUUID(),
      // Notes leave the request unchanged, so they carry no version.
      ...(action === "notes" ? {} : { expected_version: request.version }),
      ...fields,
    };
    setConsumes(consumed);
    void operation.execute(async () => {
      const receipt = await commandIntakeRequest(
        orgId,
        requestId,
        action,
        input,
      );
      if (receipt.request_id !== requestId)
        throw new Error("Mismatched intake receipt");
      return receipt;
    }, label);
  }
  function sendDetails(patch: Partial<IntakeDetails>) {
    if (!request) return;
    const input: IntakeEdit = {
      category: request.category,
      subject: request.subject,
      description: request.description,
      requester_name: request.requester_name,
      requester_email: request.requester_email,
      requester_team: request.requester_team,
      requested_by_date: request.requested_by_date,
      timezone: request.timezone,
      ...patch,
      command_id: crypto.randomUUID(),
      expected_version: request.version,
    };
    setConsumes(null);
    void operation.execute(async () => {
      const receipt = await editIntakeRequest(orgId, requestId, input);
      if (receipt.request_id !== requestId)
        throw new Error("Mismatched intake receipt");
      return receipt;
    }, "save the details");
  }
  function saveDetails(patch: Partial<IntakeDetails>) {
    if (!request) return;
    if (operation.locked || request.version < savedVersion.current) {
      queuedDetails.current = { ...queuedDetails.current, ...patch };
      return;
    }
    sendDetails(patch);
  }
  useEffect(() => {
    const queued = queuedDetails.current;
    if (!queued || !request || operation.locked) return;
    if (request.version < savedVersion.current) return;
    queuedDetails.current = null;
    sendDetails(queued);
  });
  const caps = request?.capabilities;
  const upload = useIntakeDocumentUpload(
    orgId,
    requestId,
    () => void refresh(),
  );
  // Files dropped anywhere on the page are added to the request.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const pinned = request
    ? [...messages]
        .reverse()
        .find((m) =>
          request.state === "resolved"
            ? m.kind === "resolution"
            : request.state === "cancelled" && m.kind === "cancel_reason",
        )
    : undefined;
  // Notes and changes read as one story, oldest first.
  const timeline = [
    ...events.map((event) => ({
      key: `e${event.id}`,
      at: event.created_at,
      event,
    })),
    ...messages.map((message) => ({
      key: `m${message.id}`,
      at: message.created_at,
      message,
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const assign = (assigneeId: string | null) =>
    command("assignment", "assign the request", { assignee_id: assigneeId });
  // An unresolved save stays retryable even while the request is hidden.
  const recheck = operation.uncertain && !closing && (
    <div className="flex flex-wrap items-center gap-3" role="status">
      <span className="text-sm text-gray-500">
        Checking whether it was saved. Your text is kept here.
      </span>
      <PillButtonUI
        tone="white"
        size="sm"
        disabled={operation.busy}
        onClick={() => void operation.execute()}
      >
        Check again
      </PillButtonUI>
    </div>
  );
  const hasMenu = !!caps && (caps.wait || caps.resume || caps.cancel);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        actions={
          request && caps
            ? [
                (caps.resolve || caps.reopen) && {
                  type: "custom",
                  render: caps.resolve ? (
                    <PillButtonUI
                      tone="black"
                      size="sm"
                      disabled={operation.locked}
                      onClick={() => setClosing("resolve")}
                    >
                      Resolve
                    </PillButtonUI>
                  ) : caps.reopen ? (
                    <PillButtonUI
                      tone="black"
                      size="sm"
                      disabled={operation.locked}
                      onClick={() => command("reopen", "reopen the request")}
                    >
                      Reopen
                    </PillButtonUI>
                  ) : null,
                },
                hasMenu &&
                  !operation.locked && {
                    type: "custom",
                    render: (
                      <RowActions
                        ariaLabel="More actions"
                        renderItems={(close) => (
                          <>
                            {caps.wait && (
                              <DropdownItem
                                onSelect={() => {
                                  close();
                                  command(
                                    "wait",
                                    "mark the request as waiting",
                                  );
                                }}
                              >
                                Mark waiting on requester
                              </DropdownItem>
                            )}
                            {caps.resume && (
                              <DropdownItem
                                onSelect={() => {
                                  close();
                                  command("resume", "resume the request");
                                }}
                              >
                                Resume
                              </DropdownItem>
                            )}
                            <DropdownItem
                              onSelect={() => {
                                close();
                                const link = new URL(
                                  `/intake/${requestId}?org=${orgId}`,
                                  window.location.origin,
                                ).href;
                                navigator.clipboard.writeText(link).then(
                                  () => notifySuccess("Link copied"),
                                  (e) =>
                                    notifyError(e, { action: "copy the link" }),
                                );
                              }}
                            >
                              Copy link
                            </DropdownItem>
                            {caps.cancel && (
                              <>
                                <DropdownSeparator />
                                <DropdownItem
                                  variant="destructive"
                                  onSelect={() => {
                                    close();
                                    setClosing("cancel");
                                  }}
                                >
                                  Cancel request
                                </DropdownItem>
                              </>
                            )}
                          </>
                        )}
                      />
                    ),
                  },
              ]
            : undefined
        }
        breadcrumbs={[
          {
            label: "Intake",
            onClick: () => router.push("/intake"),
            title: "Back to Intake",
          },
          {
            label:
              request && caps?.edit ? (
                <IntakeSubjectInput
                  key={detailsEpoch}
                  value={request.subject}
                  onSave={(subject) => saveDetails({ subject })}
                />
              ) : (
                request?.subject
              ),
            title: request?.subject,
            loading: !request && !error,
            cursor: "text",
          },
        ]}
      />
      <div
        className="@container relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(event) => {
          if (!request || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!request || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!request) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void upload.add(Array.from(event.dataTransfer.files));
        }}
      >
        {dragging && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl bg-white/70 text-sm text-gray-700 ring-2 ring-inset ring-blue-500/40"
          >
            Drop documents to add them to this request
          </div>
        )}
        {error ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8 md:px-6.5">
            <TableEmptyState>
              <EmptyState
                tone="error"
                title="Unable to load request"
                description={<span role="alert">{error}</span>}
                action={
                  <PillButtonUI
                    tone="black"
                    size="sm"
                    onClick={() => void refresh()}
                  >
                    Try again
                  </PillButtonUI>
                }
              />
            </TableEmptyState>
            {recheck}
          </div>
        ) : !request || !caps ? (
          <DetailSkeleton>{recheck}</DetailSkeleton>
        ) : (
          <DetailColumns
            details={
              <IntakeDetailsPanel
                key={detailsEpoch}
                request={request}
                members={members}
                accountId={accountId}
                locked={operation.locked}
                onSave={saveDetails}
                onAssign={assign}
              />
            }
          >
            {/* The page header shows the subject; this names the page for assistive technology. */}
            <h1 className="sr-only">{request.subject}</h1>
            {pinned && (
              <GlassCardUI>
                <section
                  aria-labelledby="intake-outcome"
                  className="space-y-3 p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="intake-outcome" className={SECTION_HEADING}>
                      {request.state === "resolved"
                        ? "Resolution"
                        : "Cancellation reason"}
                    </h2>
                    <button
                      type="button"
                      onClick={() =>
                        navigator.clipboard.writeText(pinned.body).then(
                          () => notifySuccess("Copied"),
                          (e) => notifyError(e, { action: "copy the text" }),
                        )
                      }
                      className="rounded-md text-xs text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                      Copy
                    </button>
                  </div>
                  <TextSlabUI className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                    {pinned.body}
                  </TextSlabUI>
                  <p className="text-xs text-gray-500">
                    {pinned.author_name} ·{" "}
                    {formatIntakeDateTime(pinned.created_at)}
                  </p>
                </section>
              </GlassCardUI>
            )}

            <GlassCardUI>
              <div className="divide-y divide-gray-100">
                <IntakeDescription
                  value={request.description}
                  editable={caps.edit}
                  locked={operation.locked}
                  onSave={(description) => saveDetails({ description })}
                />
                <div className="p-5">
                  <IntakeDocuments
                    documents={documents}
                    uploading={upload.uploading}
                    warning={upload.warning}
                    onAdd={(files) => void upload.add(files)}
                  />
                </div>
              </div>
            </GlassCardUI>

            <GlassCardUI>
              <section aria-labelledby="intake-activity">
                <h2
                  id="intake-activity"
                  className={`${SECTION_HEADING} px-5 pt-5`}
                >
                  Activity
                </h2>
                <ol className="relative space-y-4 p-5 pt-3 before:absolute before:bottom-7 before:left-[31px] before:top-6 before:w-px before:bg-gray-200">
                  {timeline.map((entry) => {
                    const line =
                      "event" in entry
                        ? describeIntakeEvent(entry.event)
                        : describeIntakeMessage(entry.message);
                    return (
                      <li key={entry.key} className="relative flex gap-3">
                        <IntakeActorAvatar name={line.actor} />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <p className="pt-0.5 text-xs leading-5 text-gray-500">
                            {line.actor && (
                              <>
                                <span className="font-medium text-gray-900">
                                  {line.actor}
                                </span>{" "}
                              </>
                            )}
                            {line.action} ·{" "}
                            <time dateTime={entry.at}>
                              {formatIntakeDateTime(entry.at)}
                            </time>
                          </p>
                          {"message" in entry && (
                            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                              {entry.message.body}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {caps.note && (
                  <div className="border-t border-gray-100 p-5">
                    <label
                      htmlFor="intake-note"
                      className="mb-2 block text-sm font-medium text-gray-700"
                    >
                      Add a note
                    </label>
                    <textarea
                      id="intake-note"
                      rows={3}
                      className={INTAKE_TEXTAREA_CLASS}
                      maxLength={20000}
                      placeholder="What happened, what the requester said, what was sent"
                      aria-describedby="intake-note-help"
                      value={note}
                      disabled={operation.locked}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p
                        id="intake-note-help"
                        className="text-xs text-gray-500"
                      >
                        Visible to everyone in your organization.
                      </p>
                      <PillButtonUI
                        tone="black"
                        size="sm"
                        disabled={!note.trim() || operation.locked}
                        onClick={() =>
                          command(
                            "notes",
                            "add the note",
                            { body: note },
                            "note",
                          )
                        }
                      >
                        Add note
                      </PillButtonUI>
                    </div>
                  </div>
                )}
              </section>
            </GlassCardUI>
            {recheck}
          </DetailColumns>
        )}
      </div>
      {closing && request && (
        <IntakeReasonModal
          title={closing === "resolve" ? "Resolve request" : "Cancel request"}
          label={
            closing === "resolve"
              ? "Resolution"
              : "Why is this being cancelled?"
          }
          hint={
            closing === "resolve"
              ? "Record the advice given or the outcome. It is pinned to the request."
              : "The reason is recorded on the request. Anyone can reopen it later."
          }
          confirmLabel={closing === "resolve" ? "Resolve" : "Cancel request"}
          confirmVariant={closing === "resolve" ? "primary" : "danger"}
          value={reason}
          onChange={setReason}
          busy={operation.busy}
          locked={operation.locked}
          status={
            operation.uncertain ? (
              <span role="status">Checking whether it was saved.</span>
            ) : undefined
          }
          secondaryAction={
            operation.uncertain
              ? {
                  label: "Check again",
                  onClick: () => void operation.execute(),
                  disabled: operation.busy,
                }
              : undefined
          }
          onConfirm={() =>
            command(
              closing,
              closing === "resolve"
                ? "resolve the request"
                : "cancel the request",
              { body: reason },
              "reason",
            )
          }
          onClose={() => setClosing(null)}
        />
      )}
    </div>
  );
}

/**
 * The request and its details, centred together. Details come first on narrow
 * screens; on wide ones they sit on the right and stay in place while the
 * page scrolls, scrolling on their own only when taller than the window.
 */
function DetailColumns({
  details,
  children,
}: {
  details: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [overflow-wrap:anywhere]">
      <div className="mx-auto grid w-full max-w-[68rem] gap-5 px-3 pb-8 pt-2 md:px-6.5 @[52rem]:grid-cols-[minmax(0,1fr)_18rem] @[52rem]:items-start">
        {/* The panel is the flat glass surface itself, so scrolling its
            content never clips the surface's shadow. */}
        <div
          className={`min-w-0 rounded-xl ${LIQUID_GLASS_FLAT_CLASS} @[52rem]:sticky @[52rem]:top-2 @[52rem]:col-start-2 @[52rem]:row-start-1 @[52rem]:max-h-[calc(100dvh-8rem)] @[52rem]:overflow-y-auto`}
        >
          {details}
        </div>
        <div className="min-w-0 space-y-5 @[52rem]:col-start-1 @[52rem]:row-start-1">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Matches the loaded page: details beside the request and its activity. */
function DetailSkeleton({ children }: { children?: ReactNode }) {
  return (
    <DetailColumns
      details={
        <div className="space-y-4 p-5" aria-hidden="true">
          <SkeletonLine className="w-16" />
          {[
            "w-28",
            "h-9 w-full",
            "h-9 w-full",
            "h-9 w-full",
            "h-9 w-full",
            "h-9 w-full",
            "w-28",
          ].map((width, index) => (
            <div key={index} className="space-y-2">
              <SkeletonLine className="w-20" />
              <SkeletonLine className={`${width} rounded-lg`} />
            </div>
          ))}
        </div>
      }
    >
      <span role="status" className="sr-only">
        Loading request…
      </span>
      <div className="space-y-5" aria-hidden="true">
        <GlassCardUI>
          <div className="space-y-2 p-5">
            <SkeletonLine className="w-16" />
            <SkeletonLine className="w-full" />
            <SkeletonLine className="w-5/6" />
          </div>
          <div className="space-y-2 border-t border-gray-100 p-5">
            <SkeletonLine className="w-20" />
            <SkeletonLine className="h-[5.25rem] w-full rounded-xl" />
          </div>
        </GlassCardUI>
        <GlassCardUI>
          <div className="space-y-4 p-5">
            <SkeletonLine className="w-16" />
            <SkeletonLine className="w-64" />
            <SkeletonLine className="w-3/4" />
          </div>
          <div className="space-y-2 border-t border-gray-100 p-5">
            <SkeletonLine className="w-20" />
            <SkeletonLine className="h-32 w-full rounded-lg" />
          </div>
        </GlassCardUI>
      </div>
      {children}
    </DetailColumns>
  );
}
