"use client";
import type {
  IntakeDelivery,
  IntakeDocument,
  IntakeMessage,
} from "@mike/contracts";
import { IntakeDeliveryStatus } from "./IntakeDeliveryStatus";
import type { IntakeUpload } from "./IntakeDocuments";
import { IntakeNoteDocuments } from "./IntakeNoteForm";
import { intakeOutgoingName } from "./intakeActivity";

/**
 * A resolution, under its change in Activity: the internal comment, which
 * stays in the app, and the reply sent to the requester, if one was, with how
 * it went. A reply of documents alone says so.
 */
export interface IntakeResolution {
  comment: IntakeMessage | null;
  reply: { message: IntakeMessage | null; delivery: IntakeDelivery } | null;
}

const LABEL = "text-xs font-medium text-gray-500";
const BODY = "whitespace-pre-wrap text-sm leading-relaxed text-gray-700";

export function IntakeResolutionDetails({
  resolution,
  documents,
  uploading,
  retrying,
  onOpenDocument,
  onRetry,
}: {
  resolution: IntakeResolution;
  documents: IntakeDocument[];
  uploading: IntakeUpload[];
  /** Deliveries being sent again. */
  retrying: string[];
  onOpenDocument: (documentId: string) => void;
  onRetry: (outboundId: string) => void;
}) {
  const { comment, reply } = resolution;
  if (!comment && !reply) return null;
  return (
    <div className="space-y-3">
      {comment && (
        <div className="space-y-1">
          <p className={LABEL}>Internal comment</p>
          <p className={BODY}>{comment.body}</p>
          <IntakeNoteDocuments
            documents={documents.filter((d) => d.message_id === comment.id)}
            uploading={uploading.filter((u) => u.messageId === comment.id)}
            onOpen={onOpenDocument}
          />
        </div>
      )}
      {reply && (
        <div className="space-y-1">
          <p className={LABEL}>Reply to the requester</p>
          {reply.message ? (
            <p className={BODY}>{reply.message.body}</p>
          ) : (
            <p className="text-sm text-gray-500">Documents only.</p>
          )}
          <IntakeDeliveryStatus
            delivery={reply.delivery}
            name={intakeOutgoingName("resolution")}
            text={reply.message?.body ?? null}
            retrying={retrying.includes(reply.delivery.outbound_id)}
            onRetry={() => onRetry(reply.delivery.outbound_id)}
          />
        </div>
      )}
    </div>
  );
}
