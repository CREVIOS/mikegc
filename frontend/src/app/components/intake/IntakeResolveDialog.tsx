"use client";
import { useId, type ReactNode } from "react";
import type { IntakeConversation, IntakeDocument } from "@mike/contracts";
import type { ModalAction } from "@/app/components/modals/Modal";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { IntakeReasonModal } from "./IntakeReasonModal";
import {
  intakeAudience,
  intakeDocumentsUnavailable,
  intakeLeftOutDocuments,
} from "./intakeConversation";

/** The most documents a resolution reply carries; the API refuses more. */
export const MAX_INTAKE_REPLY_DOCUMENTS = 10;

/** The documents a resolution reply can carry: those finished processing. */
export function sendableIntakeDocuments(documents: IntakeDocument[]) {
  return documents.filter((document) => document.status === "ready");
}

/**
 * What the resolution reply sends unless changed: documents revised since
 * they arrived, such as MikeGC's redline once its changes were accepted.
 */
export function defaultIntakeReplyDocuments(documents: IntakeDocument[]) {
  return sendableIntakeDocuments(documents)
    .filter((document) => document.revised)
    .slice(0, MAX_INTAKE_REPLY_DOCUMENTS)
    .map((document) => document.document_id);
}

/**
 * Resolves a request that has a thread: the resolution, then whether to
 * reply to the requester with it and which of the request's documents to
 * send. Ticked documents go in the order they were ticked; for email, the
 * ones past the mailbox's size limit are named rather than attached, and
 * the dialog says which before anything is sent.
 */
export function IntakeResolveDialog({
  value,
  onChange,
  conversation,
  documents,
  reply,
  onReplyChange,
  ticked,
  onTickedChange,
  busy,
  locked,
  status,
  secondaryAction,
  onConfirm,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  conversation: IntakeConversation;
  documents: IntakeDocument[];
  /** Post the resolution and ticked documents in the request's thread. */
  reply: boolean;
  onReplyChange: (reply: boolean) => void;
  /** The ticked documents' IDs, in the order they were ticked. */
  ticked: string[];
  onTickedChange: (ticked: string[]) => void;
  busy: boolean;
  locked: boolean;
  status?: ReactNode;
  secondaryAction?: ModalAction;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const replyLabel = useId();
  const replyHint = useId();
  const listLabel = useId();
  const sendable = sendableIntakeDocuments(documents);
  const unavailable = intakeDocumentsUnavailable(conversation);
  const chosen = ticked
    .map((id) => sendable.find((document) => document.document_id === id))
    .filter((document): document is IntakeDocument => !!document);
  const leftOut = new Set(
    unavailable ? [] : intakeLeftOutDocuments(conversation, chosen),
  );
  const full = chosen.length >= MAX_INTAKE_REPLY_DOCUMENTS;
  const sends = reply && (!!value.trim() || (!unavailable && chosen.length > 0));
  return (
    <IntakeReasonModal
      title="Resolve request"
      label="Resolution"
      hint="Optional. It is recorded on the request."
      confirmLabel={sends ? "Resolve and reply" : "Resolve request"}
      value={value}
      onChange={onChange}
      optional
      busy={busy}
      locked={locked}
      status={status}
      secondaryAction={secondaryAction}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <div className="space-y-3 pt-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p id={replyLabel} className="text-sm font-medium text-gray-700">
              Reply to requester
            </p>
            <p id={replyHint} className="text-xs text-gray-500">
              {intakeAudience(conversation)}
            </p>
          </div>
          <ToggleSwitchUI
            checked={reply}
            onCheckedChange={onReplyChange}
            disabled={locked}
            aria-labelledby={replyLabel}
            aria-describedby={replyHint}
            className="shrink-0"
          />
        </div>
        {reply && (
          <div className="space-y-2">
            <p id={listLabel} className="text-sm font-medium text-gray-700">
              Documents to send
            </p>
            {unavailable ? (
              <p className="text-xs text-gray-500">{unavailable}</p>
            ) : sendable.length === 0 ? (
              <p className="text-xs text-gray-500">
                The request has no documents ready to send.
              </p>
            ) : (
              <ul aria-labelledby={listLabel} className="space-y-1.5">
                {sendable.map((document) => {
                  const checked = ticked.includes(document.document_id);
                  const tooLarge = leftOut.has(document.document_id);
                  return (
                    <li key={document.document_id} className="min-w-0">
                      <label className="flex min-w-0 cursor-pointer items-start gap-0 text-sm text-gray-900 has-[:disabled]:cursor-not-allowed">
                        <input
                          type="checkbox"
                          className={`${TABLE_CHECKBOX_CLASS} mt-1.5`}
                          checked={checked}
                          disabled={locked || (!checked && full)}
                          onChange={() =>
                            onTickedChange(
                              checked
                                ? ticked.filter(
                                    (id) => id !== document.document_id,
                                  )
                                : [...ticked, document.document_id],
                            )
                          }
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {document.filename}
                          {document.revised && (
                            <span className="text-gray-500"> · revised</span>
                          )}
                          {checked && tooLarge && (
                            <span className="block text-xs text-red-600">
                              May be too large to email: it would be named
                              instead.
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {full && !unavailable && (
              <p className="text-xs text-gray-500">
                A reply can carry up to {MAX_INTAKE_REPLY_DOCUMENTS} documents.
              </p>
            )}
            {leftOut.size > 0 && (
              <p role="status" className="text-xs text-gray-700">
                {leftOut.size === 1
                  ? "1 document may be"
                  : `${leftOut.size} documents may be`}{" "}
                left out as too large to email with the ones ticked before.
                The email names {leftOut.size === 1 ? "it" : "them"} and asks
                the requester to ask Legal for a copy. Untick a larger one, or
                tick them in a different order, to send{" "}
                {leftOut.size === 1 ? "it" : "them"}.
              </p>
            )}
            {!sends && (
              <p className="text-xs text-gray-500">
                Nothing is sent without a resolution or a document.
              </p>
            )}
          </div>
        )}
      </div>
    </IntakeReasonModal>
  );
}
