"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Link2, MoreHorizontal, RotateCcw } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { useIntakeMemory, useIntakeDraft } from "./useIntakeMemory";
import type {
  IntakeAction,
  IntakeCommand,
  IntakeDelivery,
  IntakeDetails,
  IntakeDocument,
  IntakeEdit,
  IntakeEvent,
  IntakeMember,
  IntakeMessage,
  IntakeRequest,
} from "@mike/contracts";
import {
  PERSONAL_WORKSPACE,
  useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { useItemWorkspace } from "@/app/hooks/useItemWorkspace";
import {
  commandIntakeRequest,
  copyIntakeDocuments,
  editIntakeRequest,
  getIntakeDocuments,
  getIntakeEvents,
  getIntakeMembers,
  getIntakeMessages,
  getIntakeRequest,
  markIntakeReplySeen,
  retryIntakeDelivery,
} from "@/app/lib/mikeApi";
import { notifyError, notifyPartialFailure } from "@/app/lib/userFacingError";
import { notifySuccess } from "@/shared/lib/errorNotifier";
import {
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  SkeletonLine,
  TableEmptyState,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { IntakeSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { HeaderButtonUI } from "@/shared/ui/HeaderButtonsUI";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { discardIntakeDraft } from "@/app/lib/intakeMemory";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeError,
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";
import { IntakeActorAvatar, isMikeGCEvent } from "./IntakeActorAvatar";
import {
  IntakeDocuments,
  useIntakeDocumentUpload,
  useIntakeDocumentViewer,
} from "./IntakeDocuments";
import {
  IntakeNoteDocuments,
  IntakeNoteForm,
  NOTE_TITLE_CLASS,
  NOTE_TITLE_ICON_CLASS,
  type IntakeNoteMode,
} from "./IntakeNoteForm";
import { IntakeReasonModal } from "./IntakeReasonModal";
import {
  IntakeResolveDialog,
  defaultIntakeReplyDocuments,
} from "./IntakeResolveDialog";
import { IntakeDeliveryStatus } from "./IntakeDeliveryStatus";
import {
  intakeAudience,
  intakeDocumentsUnavailable,
} from "./intakeConversation";
import {
  IntakeDescription,
  IntakeDetailsPanel,
  IntakeSubjectInput,
} from "./IntakeDetailsPanel";
import { formatIntakeDateTime, intakeDeleteMessage } from "./intakeLabels";
import {
  describeIntakeEvent,
  describeIntakeMessage,
  intakeOutgoingName,
} from "./intakeActivity";
import { INTAKE_REQUESTS_PATH } from "./intakeQuery";
import {
  IntakeDocumentPicker,
  type IntakePickedDocument,
} from "./IntakeDocumentPicker";

/** Every section on the request page is introduced the same way. */
const SECTION_HEADING = "text-sm font-medium text-gray-900";
/** Quiet refreshes when the window regains focus are at most this frequent. */
const FOCUS_REFRESH_MS = 30_000;
/** How often the page checks on a message to the requester still sending. */
const DELIVERY_REFRESH_MS = 5_000;

/** Scope a deep-linked request to its workspace before mounting retained drafts. */
export function IntakeDetail({
  orgId,
  requestId,
}: {
  orgId: string;
  requestId: string;
}) {
  const { accountId, workspaceId } = useWorkspace();
  // Personal is no organization to the workspace switcher.
  useItemWorkspace(requestId, orgId === PERSONAL_WORKSPACE ? null : orgId);
  if (!accountId || workspaceId !== orgId)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <TableEmptyState>
          <EmptyState
            icon={<IntakeSkeuoIcon />}
            title="Intake"
            description="Open this request in its workspace."
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
/**
 * What to announce about messages to the requester that were still sending
 * at the last load and have settled since, remembering each one's state.
 */
function settledDeliveryAnnouncement(
  seen: Map<string, IntakeDelivery["status"]>,
  deliveries: IntakeDelivery[],
): string {
  let said = "";
  for (const delivery of deliveries) {
    if (seen.get(delivery.outbound_id) === "pending" && delivery.status !== "pending")
      said =
        delivery.status === "sent"
          ? "Message to the requester sent."
          : `Couldn't send the message to the requester: ${delivery.error ?? "try again"}.`;
    seen.set(delivery.outbound_id, delivery.status);
  }
  return said;
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
/** The fields an edit sends, all of them, at the request's version. */
const DETAIL_KEYS = [
  "subject",
  "description",
  "requester_name",
  "requester_email",
  "requester_team",
  "requested_by_date",
] as const satisfies readonly (keyof IntakeDetails)[];
function detailsOf(request: IntakeDetails): IntakeDetails {
  return {
    subject: request.subject,
    description: request.description,
    requester_name: request.requester_name,
    requester_email: request.requester_email,
    requester_team: request.requester_team,
    requested_by_date: request.requested_by_date,
  };
}
type Closing = "resolve" | "cancel";
/**
 * Which retained draft a successful command has consumed: the note and its
 * documents, only the note's text (a message to the requester, which sends
 * no documents), or the cancel reason. "request" means the request itself
 * is gone, so the page leaves it.
 */
type Consumed = "note" | "message" | "reason" | "request" | null;
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
  // Documents to upload with the note once it is saved, kept with its text.
  const [noteFiles, setNoteFiles] = useIntakeDraft<File[]>(
    memory,
    "noteFiles",
    [],
  );
  // Library documents chosen for the note, copied onto it once it is saved.
  const [notePicked, setNotePicked] = useIntakeDraft<IntakePickedDocument[]>(
    memory,
    "notePicked",
    [],
  );
  // Which Add documents modal is open: the request's, or the note's.
  const [picking, setPicking] = useState<"request" | "note" | null>(null);
  const [noteWarning, setNoteWarning] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
  // An internal note, or a message to the requester in the request's thread.
  const [noteMode, setNoteMode] = useIntakeDraft<IntakeNoteMode>(
    memory,
    "noteMode",
    "note",
  );
  // The resolve dialog's reply: whether it goes, and its documents in the
  // order they were ticked.
  const [resolveReply, setResolveReply] = useIntakeDraft(
    memory,
    "resolveReply",
    true,
  );
  const [resolveDocuments, setResolveDocuments] = useIntakeDraft<string[]>(
    memory,
    "resolveDocuments",
    [],
  );
  // Messages to the requester being sent again.
  const [retrying, setRetrying] = useState<string[]>([]);
  // Said politely when a message to the requester is sent or fails.
  const [announcement, setAnnouncement] = useState("");
  const deliveryStates = useRef(new Map<string, IntakeDelivery["status"]>());
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    try {
      const r = await getIntakeRequest(orgId, requestId);
      const [m, e, d, roster] = await Promise.all([
        allPages((offset) => getIntakeMessages(orgId, requestId, offset)),
        allPages((offset) => getIntakeEvents(orgId, requestId, offset)),
        getIntakeDocuments(orgId, requestId),
        // Members are who an open request can be assigned to, and every
        // request's people take their photos from them. A closed request
        // falls back to initials if they cannot be read.
        r.capabilities.assign
          ? getIntakeMembers(orgId)
          : getIntakeMembers(orgId).catch(() => []),
      ]);
      if (generation !== epoch.current) return;
      setRequest(r);
      setMessages(m);
      setEvents(e);
      setDocuments(d);
      setMembers(roster);
      setError(null);
      // A message to the requester that settled since the last load is said once.
      const said = settledDeliveryAnnouncement(deliveryStates.current, [
        ...m.flatMap((message) => (message.delivery ? [message.delivery] : [])),
        ...e.flatMap((event) => (event.delivery ? [event.delivery] : [])),
      ]);
      if (said) setAnnouncement(said);
      // Opening the request clears its New reply flag in the queue.
      if (r.new_reply)
        void markIntakeReplySeen(orgId, requestId).catch(() => {
          // Only the queue's marker stays; the request itself is on screen.
        });
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
  const upload = useIntakeDocumentUpload(
    orgId,
    requestId,
    () => void refresh(),
  );
  const viewer = useIntakeDocumentViewer();
  /** Copy library documents onto the request, or onto a saved note. */
  function addPicked(
    picked: IntakePickedDocument[],
    messageId: string | null,
    withNote = false,
  ) {
    copyIntakeDocuments(
      orgId,
      requestId,
      picked.map((document) => document.id),
      messageId,
    ).then(
      () => void refresh(),
      (e) => {
        // The note is saved either way; only its documents need adding.
        if (withNote)
          notifyPartialFailure(
            "The note was added, but its library documents couldn't all be added. Add them to the request's documents instead.",
            { action: "add the documents" },
          );
        else notifyError(e, { action: "add the documents" });
        void refresh();
      },
    );
  }
  const operation = useIntakeOperation(
    (receipt) => {
      if (consumes === "request") {
        discardIntakeDraft(memory);
        notifySuccess("Request deleted");
        router.push(INTAKE_REQUESTS_PATH);
        return;
      }
      savedVersion.current = receipt.applied_version;
      if (consumes === "note") {
        // The note exists now, so its documents can be added with it.
        // A resolution without text has no message, so its documents go
        // to the request itself rather than being lost.
        if (noteFiles.length)
          void upload.add(noteFiles, receipt.message_id ?? undefined);
        if (notePicked.length)
          addPicked(
            notePicked,
            receipt.message_id ?? null,
            // A resolution without text saved no note to report.
            !!receipt.message_id,
          );
        setNote("");
        setNoteFiles([]);
        setNotePicked([]);
        setNoteWarning(null);
      }
      if (consumes === "note" && closing === "resolve") {
        setClosing(null);
        setResolveDocuments([]);
        setResolveReply(true);
      }
      if (consumes === "message") setNote("");
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
  useIntakeDraftWarning(
    !!note ||
      noteFiles.length > 0 ||
      notePicked.length > 0 ||
      !!reason ||
      operation.locked,
  );
  function openNoteForResolution() {
    // The comment box is always there; bring it into view.
    requestAnimationFrame(() =>
      document
        .getElementById("intake-note")
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }
  function focusNote() {
    document.getElementById("intake-note")?.focus({ preventScroll: true });
  }
  /** Send a command at the latest version this page knows; recovery reuses the same command. */
  function command(
    action: IntakeAction,
    label: string,
    fields: Pick<
      IntakeCommand,
      "body" | "assignee_id" | "send_to_requester" | "documents"
    > = {},
    consumed: Consumed = null,
  ) {
    // A command that would not start must not claim a draft either: its
    // receipt would be read as this command's.
    if (!request || !operation.idle()) return;
    const input: IntakeCommand = {
      command_id: crypto.randomUUID(),
      // Notes leave the request unchanged, so they carry no version. This
      // page's own last change may not be on screen yet: its version is the
      // request's now, unless someone else has changed it since.
      ...(action === "notes"
        ? {}
        : {
            expected_version: Math.max(request.version, savedVersion.current),
          }),
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
    const details = { ...detailsOf(request), ...patch };
    // A field left after Enter, or an edit queued behind its own save, can
    // name only what is saved already: sending it would record a change.
    if (DETAIL_KEYS.every((key) => details[key] === request[key])) return;
    const input: IntakeEdit = {
      ...details,
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
    if (!operation.idle() || request.version < savedVersion.current) {
      queuedDetails.current = { ...queuedDetails.current, ...patch };
      return;
    }
    sendDetails(patch);
  }
  useEffect(() => {
    const queued = queuedDetails.current;
    if (!queued || !request || !operation.idle()) return;
    if (request.version < savedVersion.current) return;
    queuedDetails.current = null;
    sendDetails(queued);
  });
  const caps = request?.capabilities;
  const conversation = request?.conversation ?? null;
  // The note form can message the requester while the request has a thread.
  const audience =
    conversation && caps?.send_to_requester
      ? intakeAudience(conversation)
      : null;
  /** Resolve: with a thread, the dialog that also replies; else at once. */
  function startResolving() {
    if (!request) return;
    if (conversation) {
      setResolveReply(true);
      setResolveDocuments(defaultIntakeReplyDocuments(documents));
      setClosing("resolve");
    } else
      command(
        "resolve",
        "resolve the request",
        // The comment, if any, is the resolution.
        note.trim() ? { body: note } : {},
        "note",
      );
  }
  function confirmResolving() {
    const sendDocuments =
      resolveReply &&
      conversation &&
      !intakeDocumentsUnavailable(conversation) &&
      resolveDocuments.length > 0;
    command(
      "resolve",
      "resolve the request",
      {
        ...(note.trim() ? { body: note } : {}),
        ...(resolveReply ? { send_to_requester: true } : {}),
        ...(sendDocuments ? { documents: resolveDocuments } : {}),
      },
      "note",
    );
  }
  // Messages to the requester still sending are checked on until they settle.
  const deliveries = [
    ...messages.flatMap((m) => (m.delivery ? [m.delivery] : [])),
    ...events.flatMap((e) => (e.delivery ? [e.delivery] : [])),
  ];
  const sending = deliveries.some((d) => d.status === "pending");
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => void refresh(), DELIVERY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [sending, refresh]);
  function retryDelivery(outboundId: string) {
    setRetrying((current) => [...current, outboundId]);
    // Settled either way: the timeline then shows how it is going.
    const settled = () => {
      setRetrying((current) => current.filter((id) => id !== outboundId));
      void refresh();
    };
    retryIntakeDelivery(orgId, requestId, outboundId).then(settled, (e) => {
      notifyError(e, {
        action: "send the message again",
        onRetry: () => retryDelivery(outboundId),
      });
      settled();
    });
  }
  // Files dropped anywhere on the page are added to the request; dropped on
  // the note form, they wait to be added with the note.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const noteBox = useRef<HTMLDivElement>(null);
  const [overNote, setOverNote] = useState(false);
  const addNoteFiles = (candidates: File[]) => {
    const { supported, unsupported } =
      partitionSupportedDocumentFiles(candidates);
    setNoteWarning(formatUnsupportedDocumentWarning(unsupported));
    if (supported.length) setNoteFiles((current) => [...current, ...supported]);
  };
  // A resolution or cancellation reason reads in the timeline beside the
  // change, and a closed request is reopened where a note would be added.
  const closed =
    request?.state === "resolved" || request?.state === "cancelled";
  // A resolution is saved with its "resolved" change in one transaction, so
  // they share a time: the resolution reads under that change, not alone.
  const resolutions = new Map<number, IntakeMessage>();
  for (const event of events) {
    if (event.kind !== "resolve") continue;
    const text = messages.find(
      (m) => m.kind === "resolution" && m.created_at === event.created_at,
    );
    if (text) resolutions.set(event.id, text);
  }
  const shown = new Set([...resolutions.values()].map((m) => m.id));
  // Notes and changes read as one story, oldest first.
  const timeline = [
    ...events.map((event) => ({
      key: `e${event.id}`,
      at: event.created_at,
      event,
      text: resolutions.get(event.id),
    })),
    ...messages
      .filter((message) => !shown.has(message.id))
      .map((message) => ({
        key: `m${message.id}`,
        at: message.created_at,
        message,
      })),
  ].sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      // A resolution or reason is saved with its change in one transaction,
      // so they share a time; the text that caused the change reads first.
      Number("event" in a) - Number("event" in b),
  );
  const assign = (assigneeId: string | null) =>
    command("assignment", "assign the request", { assignee_id: assigneeId });
  // An unresolved save stays retryable even while the request is hidden. The
  // cancel dialog offers its own Check again, but only while the request shows.
  const cancelRechecks =
    (closing === "cancel" || (closing === "resolve" && !!conversation)) &&
    !!request;
  const recheck = operation.uncertain && !cancelRechecks && (
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        actions={
          request
            ? [
                {
                  title: "Copy link",
                  iconOnly: true,
                  icon: <Link2 aria-hidden="true" className="h-4 w-4" />,
                  onClick: () => {
                    const link = new URL(
                      `/intake/${requestId}?org=${orgId}`,
                      window.location.origin,
                    ).href;
                    navigator.clipboard.writeText(link).then(
                      () => notifySuccess("Link copied"),
                      (e) => notifyError(e, { action: "copy the link" }),
                    );
                  },
                },
                caps?.delete &&
                  !operation.locked && {
                    type: "custom",
                    render: (
                      // A round trigger to match the other header buttons.
                      <Dropdown>
                        <DropdownTrigger asChild>
                          <HeaderButtonUI iconOnly aria-label="More actions">
                            <MoreHorizontal
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                          </HeaderButtonUI>
                        </DropdownTrigger>
                        <DropdownContent align="end">
                          <DropdownItem
                            variant="destructive"
                            onSelect={() => setConfirmingDelete(true)}
                          >
                            Delete request
                          </DropdownItem>
                        </DropdownContent>
                      </Dropdown>
                    ),
                  },
              ]
            : undefined
        }
        breadcrumbs={[
          {
            label: "Intake",
            onClick: () => router.push(INTAKE_REQUESTS_PATH),
            title: "Back to Intake",
          },
          {
            label: "Requests",
            onClick: () => router.push(INTAKE_REQUESTS_PATH),
            title: "Back to requests",
          },
          {
            label: request?.subject,
            title: request?.subject,
            loading: !request && !error,
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
          setOverNote(!!noteBox.current?.contains(event.target as Node));
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) {
            setDragging(false);
            setOverNote(false);
          }
        }}
        onDrop={(event) => {
          // Text dragged into a field drops as usual; only files are taken.
          if (!request || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          setOverNote(false);
          const files = Array.from(event.dataTransfer.files);
          if (noteBox.current?.contains(event.target as Node)) {
            // A note being saved takes no more files: they would be tagged
            // on it once it is saved, though it was sent without them.
            if (!operation.locked) addNoteFiles(files);
          } else void upload.add(files);
        }}
      >
        {dragging && !overNote && (
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
            title={
              caps.edit ? (
                <>
                  {/* The title edits in place; this names the page for assistive technology. */}
                  <h1 className="sr-only">{request.subject}</h1>
                  <IntakeSubjectInput
                    key={detailsEpoch}
                    value={request.subject}
                    onSave={(subject) => saveDetails({ subject })}
                    className="font-serif text-2xl font-medium"
                  />
                </>
              ) : (
                <h1 className="font-serif text-2xl font-medium text-gray-900 [overflow-wrap:anywhere]">
                  {request.subject}
                </h1>
              )
            }
            details={
              <IntakeDetailsPanel
                key={detailsEpoch}
                request={request}
                members={members}
                accountId={accountId}
                locked={operation.locked}
                onSave={saveDetails}
                onAssign={assign}
                // The resolve dialog takes focus itself.
                onStatusMenuClosed={conversation ? undefined : focusNote}
                onStopAsking={() =>
                  command("stop_asking", "stop MikeGC asking the requester")
                }
                onStatus={(action) => {
                  // Resolving is written as a note: open the note form and
                  // bring it into view; "Resolve request" there saves it.
                  // With a thread, the resolve dialog also replies there.
                  if (action === "resolve") {
                    if (conversation) startResolving();
                    else openNoteForResolution();
                  } else if (action === "cancel") setClosing(action);
                  else
                    command(
                      action,
                      action === "wait"
                        ? "mark the request as waiting"
                        : action === "resume"
                          ? "resume the request"
                          : "reopen the request",
                    );
                }}
              />
            }
          >
            <GlassCardUI>
              <div className="divide-y divide-gray-100">
                <IntakeDescription
                  value={request.description}
                  editable={caps.edit}
                  locked={operation.locked}
                  onSave={(description) => saveDetails({ description })}
                />
                <div className="px-5 py-4">
                  <IntakeDocuments
                    documents={documents}
                    uploading={upload.uploading.map((u) => u.file)}
                    warning={upload.warning}
                    onAdd={(files) => void upload.add(files)}
                    onOpen={(documentId) => void viewer.open(documentId)}
                    onBrowse={() => setPicking("request")}
                  />
                </div>
              </div>
            </GlassCardUI>

            <GlassCardUI>
              <section aria-labelledby="intake-activity">
                <h2
                  id="intake-activity"
                  className={`${SECTION_HEADING} px-5 pt-4`}
                >
                  Activity
                </h2>
                <p aria-live="polite" className="sr-only">
                  {announcement}
                </p>
                <ol className="relative space-y-4 px-5 pb-4 pt-3 before:absolute before:bottom-6 before:left-[31px] before:top-6 before:w-px before:bg-gray-200">
                  {timeline.map((entry) => {
                    const line =
                      "event" in entry
                        ? describeIntakeEvent(entry.event)
                        : describeIntakeMessage(entry.message);
                    return (
                      <li key={entry.key} className="relative flex gap-3">
                        <IntakeActorAvatar
                          name={line.actor}
                          mikegc={
                            "event" in entry
                              ? isMikeGCEvent(entry.event)
                              : !!entry.message.automated
                          }
                          photo={
                            members.find(
                              (m) =>
                                m.user_id ===
                                ("event" in entry
                                  ? entry.event.actor_id
                                  : entry.message.author_id),
                            )?.profile_photo
                          }
                        />
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
                          {(() => {
                            // A note's text, or a resolution under its change.
                            const text =
                              "message" in entry ? entry.message : entry.text;
                            if (!text) return null;
                            return (
                              <>
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                                  {text.body}
                                </p>
                                <IntakeNoteDocuments
                                  documents={documents.filter(
                                    (d) => d.message_id === text.id,
                                  )}
                                  uploading={upload.uploading.filter(
                                    (u) => u.messageId === text.id,
                                  )}
                                  onOpen={(documentId) =>
                                    void viewer.open(documentId)
                                  }
                                />
                              </>
                            );
                          })()}
                          {(() => {
                            // A question, or a resolution reply, sent to the requester.
                            const delivery =
                              "message" in entry
                                ? entry.message.delivery
                                : entry.event.delivery;
                            if (!delivery) return null;
                            const question =
                              "message" in entry ||
                              delivery.kind === "question";
                            return (
                              <IntakeDeliveryStatus
                                delivery={delivery}
                                name={intakeOutgoingName(
                                  question ? "question" : "resolution",
                                )}
                                text={
                                  "message" in entry
                                    ? entry.message.body
                                    : entry.text?.body
                                }
                                retrying={retrying.includes(
                                  delivery.outbound_id,
                                )}
                                onRetry={() =>
                                  retryDelivery(delivery.outbound_id)
                                }
                              />
                            );
                          })()}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {/* A closed request is reopened here rather than noted. */}
                {closed && caps.reopen && (
                  <div className="border-t border-gray-100 px-5 py-4">
                    <button
                      type="button"
                      disabled={operation.locked}
                      onClick={() => command("reopen", "reopen the request")}
                      className={cn(
                        "group flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60",
                        NOTE_TITLE_CLASS,
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("-ml-1", NOTE_TITLE_ICON_CLASS)}
                      >
                        <RotateCcw className="h-4 w-4 group-hover:text-gray-900" />
                      </span>
                      Reopen
                    </button>
                  </div>
                )}
                {/* An outstanding request always has its comment box open. */}
                {!closed && caps.note && (
                  <IntakeNoteForm
                    boxRef={noteBox}
                    note={note}
                    files={noteFiles}
                    warning={noteWarning}
                    dropping={dragging && overNote}
                    locked={operation.locked}
                    onNoteChange={setNote}
                    onAddFiles={addNoteFiles}
                    onRemoveFile={(index) =>
                      setNoteFiles((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                    picked={notePicked}
                    onBrowse={() => setPicking("note")}
                    onRemovePicked={(id) =>
                      setNotePicked((current) =>
                        current.filter((document) => document.id !== id),
                      )
                    }
                    onResolve={caps.resolve ? startResolving : undefined}
                    audience={audience}
                    mode={audience ? noteMode : "note"}
                    onModeChange={setNoteMode}
                    onSubmit={() =>
                      audience && noteMode === "message"
                        ? command(
                            "wait",
                            "send the question to the requester",
                            { body: note, send_to_requester: true },
                            "message",
                          )
                        : command("notes", "add the note", { body: note }, "note")
                    }
                  />
                )}
              </section>
            </GlassCardUI>
            {recheck}
          </DetailColumns>
        )}
      </div>
      {viewer.panel}
      <IntakeDocumentPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        onPick={(picked) => {
          if (picking === "note")
            setNotePicked((current) => [
              ...current,
              ...picked.filter((p) => !current.some((c) => c.id === p.id)),
            ]);
          else addPicked(picked, null);
        }}
      />
      <ConfirmPopup
        open={confirmingDelete}
        title="Delete this request?"
        message={intakeDeleteMessage(orgId, false)}
        confirmLabel="Delete request"
        confirmVariant="danger"
        cancelLabel="Keep request"
        confirmDisabled={operation.locked}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          command("delete", "delete the request", {}, "request");
        }}
      />
      {/* With a thread, resolving asks what to send the requester. */}
      {closing === "resolve" && request && conversation && (
        <IntakeResolveDialog
          value={note}
          onChange={setNote}
          conversation={conversation}
          documents={documents}
          reply={resolveReply}
          onReplyChange={setResolveReply}
          ticked={resolveDocuments}
          onTickedChange={setResolveDocuments}
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
          onConfirm={confirmResolving}
          onClose={() => {
            // The resolution is the note's text, which stays as a draft.
            setClosing(null);
          }}
        />
      )}
      {/* Without a thread, resolving happens in the note form; cancelling asks here. */}
      {closing === "cancel" && request && (
        <IntakeReasonModal
          title="Cancel request"
          label="Why is this being cancelled?"
          hint="The reason is recorded on the request. Anyone can reopen it later."
          confirmLabel="Cancel request"
          confirmVariant="danger"
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
            command("cancel", "cancel the request", { body: reason }, "reason")
          }
          onClose={() => {
            // Closing the dialog discards its reason, as closing a form does.
            setReason("");
            setClosing(null);
          }}
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
export function DetailColumns({
  title,
  details,
  children,
}: {
  /** Sits above the request, so the sidebar's top lines up with the first card. */
  title?: ReactNode;
  details: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [overflow-wrap:anywhere]">
      <div className="mx-auto grid w-full max-w-[68rem] gap-5 px-3 pb-8 pt-2 md:px-6.5 @[52rem]:grid-cols-[minmax(0,1fr)_18rem] @[52rem]:items-start">
        {title && (
          <div className="min-w-0 @[52rem]:col-start-1 @[52rem]:row-start-1">
            {title}
          </div>
        )}
        {/* The panel is the flat glass surface itself, so scrolling its
            content never clips the surface's shadow. */}
        <div
          className={`min-w-0 rounded-xl ${LIQUID_GLASS_FLAT_CLASS} @[52rem]:sticky @[52rem]:top-2 @[52rem]:col-start-2 @[52rem]:row-start-2 @[52rem]:max-h-[calc(100dvh-8rem)] @[52rem]:overflow-y-auto`}
        >
          {details}
        </div>
        <div className="min-w-0 space-y-5 @[52rem]:col-start-1 @[52rem]:row-start-2">
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
      title={<SkeletonLine className="h-7 w-2/3 rounded-lg" />}
      details={
        <div className="space-y-4 px-5 py-4" aria-hidden="true">
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
          <div className="space-y-2 px-5 py-4">
            <SkeletonLine className="w-16" />
            <SkeletonLine className="w-full" />
            <SkeletonLine className="w-5/6" />
          </div>
          <div className="space-y-2 border-t border-gray-100 px-5 py-4">
            <SkeletonLine className="w-20" />
            <SkeletonLine className="h-[5.25rem] w-full rounded-xl" />
          </div>
        </GlassCardUI>
        <GlassCardUI>
          <div className="space-y-4 px-5 py-4">
            <SkeletonLine className="w-16" />
            <SkeletonLine className="w-64" />
            <SkeletonLine className="w-3/4" />
          </div>
          <div className="space-y-2 border-t border-gray-100 px-5 py-4">
            <SkeletonLine className="w-20" />
            <SkeletonLine className="h-32 w-full rounded-lg" />
          </div>
        </GlassCardUI>
      </div>
      {children}
    </DetailColumns>
  );
}
