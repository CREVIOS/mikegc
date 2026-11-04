import type {
  IntakeDocument,
  IntakeMessage,
  IntakeRequest,
} from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import {
  getIntakeRequest,
  listIntakeMessages,
  type IntakeScope,
} from "./intake.requests";
import { listIntakeDocuments } from "./intake.documents";
import { intakeRpc } from "./intake.shared";

/**
 * The assistant working on an intake request: a chat started from a request
 * reads the request, its history and its documents on every turn, as the
 * person asking sees them.
 */

/** The longest brief a turn carries; the request's description is the most of it. */
const BRIEF_MAX = 40000;
/** The most history entries the brief lists, newest kept. */
const HISTORY_MAX = 80;

const STATE_LABELS: Record<IntakeRequest["state"], string> = {
  submitted: "New",
  in_review: "In progress",
  needs_information: "Waiting on requester",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

/**
 * The organization holding a request the actor can read, and whether it is
 * their Personal one, so a chat started from it is filed in its workspace.
 */
export async function intakeRequestWorkspace(
  db: Db,
  actorId: string,
  requestId: string,
): Promise<ServiceResult<{ orgId: string; personal: boolean }>> {
  const { data, error } = await db
    .from("intake_requests")
    .select("org_id")
    .eq("id", requestId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const row = data as { org_id: string } | null;
  if (!row) return failure("not_found", "Request not found.");
  const readable = await intakeRpc<boolean>(db, "intake_can_read", {
    p_org: row.org_id,
    p_actor: actorId,
    p_request: requestId,
  });
  if (!readable.ok) return readable;
  if (!readable.data) return failure("not_found", "Request not found.");
  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("kind")
    .eq("id", row.org_id)
    .maybeSingle();
  if (orgError) return internalFailure(orgError);
  return ok({
    orgId: row.org_id,
    personal: (org as { kind?: string } | null)?.kind === "personal",
  });
}

/**
 * What a chat started from the request knows of it: its details, its
 * history oldest first, and its documents, which the chat reads and, while
 * the request is open, edits. The text is the request's own and the
 * requester's words, so the chat fences it as data.
 */
export async function intakeChatBrief(
  db: Db,
  actorId: string,
  requestId: string,
): Promise<ServiceResult<{ brief: string; documentIds: string[] }>> {
  const workspace = await intakeRequestWorkspace(db, actorId, requestId);
  if (!workspace.ok) return workspace;
  const scope: IntakeScope = { orgId: workspace.data.orgId, actorId };
  const [request, messages, documents] = await Promise.all([
    getIntakeRequest(db, scope, requestId),
    listIntakeMessages(db, scope, requestId, { offset: 0, limit: 100 }),
    listIntakeDocuments(db, scope, requestId),
  ]);
  if (!request.ok) return request;
  if (!messages.ok) return messages;
  if (!documents.ok) return documents;
  if (!request.data) return failure("not_found", "Request not found.");
  return ok({
    brief: composeIntakeBrief(request.data, messages.data, documents.data),
    documentIds: documents.data
      .filter((d) => d.status === "ready")
      .map((d) => d.document_id),
  });
}

/** The brief as plain text: details, request, history, documents. */
export function composeIntakeBrief(
  request: IntakeRequest,
  messages: IntakeMessage[],
  documents: IntakeDocument[],
): string {
  const requester = [
    request.requester_name,
    request.requester_email && `<${request.requester_email}>`,
    request.requester_team && `(${request.requester_team})`,
  ]
    .filter(Boolean)
    .join(" ");
  const details = [
    `Subject: ${request.subject}`,
    `Status: ${STATE_LABELS[request.state] ?? request.state}`,
    `Requester: ${requester || "Unknown"}`,
    `Reviewer: ${request.assignee_name ?? "Unassigned"}`,
    `Target date: ${request.requested_by_date ?? "None"}`,
    `Recorded: ${request.created_at}`,
  ];
  const history = messages.slice(-HISTORY_MAX).map((m) => {
    const who = m.automated ? "MikeGC" : m.author_name;
    const what =
      m.purpose === "preprocessing"
        ? "preprocessing"
        : m.kind === "reply"
          ? `reply from the requester${m.external_author?.source ? ` in ${m.external_author.source}` : ""}`
          : m.kind === "question"
            ? "question sent to the requester"
            : m.kind === "answer"
              ? "reply sent to the requester"
              : m.kind === "resolution"
                ? "resolution"
                : m.kind === "cancel_reason"
                  ? "reason for cancelling"
                  : "internal note";
    return `[${m.created_at}] ${who}, ${what}:\n${m.body}`;
  });
  const files = documents.map(
    (d) =>
      `- ${d.filename}${d.revised ? " (revised since it arrived)" : ""}${d.status === "ready" ? "" : " (still processing)"}`,
  );
  const brief = [
    "REQUEST DETAILS",
    ...details,
    "",
    "REQUEST",
    request.description,
    "",
    "HISTORY (oldest first)",
    history.length ? history.join("\n\n") : "None yet.",
    "",
    "DOCUMENTS",
    files.length ? files.join("\n") : "None.",
  ].join("\n");
  return brief.length > BRIEF_MAX
    ? `${brief.slice(0, BRIEF_MAX)}\n[Shortened to fit.]`
    : brief;
}
