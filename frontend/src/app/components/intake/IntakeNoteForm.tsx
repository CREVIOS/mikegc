"use client";

import { useId, useRef, type Ref } from "react";
import { Paperclip } from "lucide-react";
import type { IntakeDocument } from "@mike/contracts";
import { cn } from "@/app/lib/utils";
import { DocumentPill } from "@/app/components/shared/DocumentPill";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import { LIQUID_GLASS_SELECTED_CLASS } from "@/app/components/ui/liquid-surface";
import { INTAKE_TEXTAREA_CLASS } from "./IntakeDetailsPanel";
import { IntakeDocumentSpinner, type IntakeUpload } from "./IntakeDocuments";
import type { IntakePickedDocument } from "./IntakeDocumentPicker";

const TEXT_BUTTON_CLASS =
  "rounded-md px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

/** The note form's title, and the button that opens the form under the same name. */
export const NOTE_TITLE_CLASS = "text-sm font-medium text-gray-700";
/** The icon before the title: Close when the form is open, a plus when it is not. */
export const NOTE_TITLE_ICON_CLASS =
  "rounded-full p-0.5 text-gray-400 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60";

/** An internal note, or a message posted to the requester in the request's thread. */
export type IntakeNoteMode = "note" | "message";

const MODES: { value: IntakeNoteMode; label: string }[] = [
  { value: "note", label: "Internal note" },
  { value: "message", label: "Message requester" },
];

/**
 * Writes a note, with documents to add alongside it: chosen here or dropped
 * on the box. The page uploads them once the note is saved, so they are
 * tagged on the note and listed with the request's documents. Resolve
 * request, beside Submit, resolves the request when it can be resolved, with
 * any comment as the resolution.
 *
 * On a request with a thread, it can instead message the requester: the
 * text is posted there as a question and the request waits on the answer.
 * Only the text goes; documents stay with the draft note.
 */
export function IntakeNoteForm({
  boxRef,
  note,
  files,
  warning,
  dropping,
  locked,
  onNoteChange,
  onAddFiles,
  onRemoveFile,
  picked = [],
  onBrowse,
  onRemovePicked,
  onResolve,
  onSubmit,
  audience,
  mode = "note",
  onModeChange,
}: {
  /** The box the page treats as the note's drop target. */
  boxRef: Ref<HTMLDivElement>;
  note: string;
  files: File[];
  warning: string | null;
  /** Files are being dragged over the box. */
  dropping: boolean;
  locked: boolean;
  onNoteChange: (note: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  /** Library documents chosen to add with the note, copied once it is saved. */
  picked?: IntakePickedDocument[];
  /** Opens the Add documents modal; without it the button browses files. */
  onBrowse?: () => void;
  onRemovePicked?: (id: string) => void;
  /** Open the resolve dialog; absent when the request cannot be resolved. */
  onResolve?: () => void;
  onSubmit: () => void;
  /**
   * Who a message to the requester reaches, such as "Posts in the Slack
   * thread in #legal, visible to everyone in the channel". Without it the
   * form writes notes only.
   */
  audience?: string | null;
  mode?: IntakeNoteMode;
  onModeChange?: (mode: IntakeNoteMode) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const modeName = useId();
  const audienceId = useId();
  const messaging = !!audience && mode === "message";
  return (
    <div className="border-t border-gray-100 p-5">
      {audience && onModeChange && (
        <fieldset className="mb-3">
          <legend className="sr-only">Who sees this comment</legend>
          <div className="flex flex-wrap gap-1">
            {MODES.map((option) => {
              const checked = mode === option.value;
              return (
                <label
                  key={option.value}
                  className={cn(
                    "relative inline-flex h-7 cursor-pointer items-center rounded-full px-3 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                    checked
                      ? cn(LIQUID_GLASS_SELECTED_CLASS, "text-gray-900")
                      : "text-gray-500 hover:text-gray-900",
                  )}
                >
                  <input
                    type="radio"
                    name={modeName}
                    value={option.value}
                    checked={checked}
                    disabled={locked}
                    onChange={() => onModeChange(option.value)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <label
        htmlFor="intake-note"
        className={cn("mb-2 block", NOTE_TITLE_CLASS)}
      >
        {messaging ? "Message the requester" : "Add comment"}
      </label>
      {/* The documents and actions sit inside the box, under the text. */}
      <div
        ref={boxRef}
        className={cn(
          "rounded-lg bg-gray-100 transition-shadow focus-within:ring-2 focus-within:ring-gray-300/45",
          dropping && "ring-2 ring-inset ring-blue-500/40",
        )}
      >
        <textarea
          id="intake-note"
          rows={3}
          className={cn(
            INTAKE_TEXTAREA_CLASS,
            "bg-transparent focus:border-transparent focus:ring-0",
          )}
          maxLength={20000}
          placeholder={
            messaging
              ? "What do you need from the requester?"
              : "What happened, what the requester said, what was sent"
          }
          aria-describedby={messaging ? audienceId : undefined}
          value={note}
          disabled={locked}
          onChange={(e) => onNoteChange(e.target.value)}
        />
        {messaging && (
          <p id={audienceId} className="px-3 pb-2 text-xs text-gray-500">
            {audience} Only the text is sent
            {files.length + picked.length > 0
              ? "; the documents below stay with your draft note."
              : "."}
          </p>
        )}
        {files.length + picked.length > 0 && (
          <ul
            aria-label="Documents to add with the note"
            className="flex flex-wrap gap-1.5 px-3 pb-2"
          >
            {files.map((file, index) => (
              <li key={`${file.name}:${index}`} className="min-w-0">
                <DocumentPill
                  filename={file.name}
                  onRemove={() => onRemoveFile(index)}
                  removeDisabled={locked}
                />
              </li>
            ))}
            {picked.map((document) => (
              <li key={document.id} className="min-w-0">
                <DocumentPill
                  filename={document.filename}
                  onRemove={() => onRemovePicked?.(document.id)}
                  removeDisabled={locked}
                />
              </li>
            ))}
          </ul>
        )}
        {warning && (
          <p role="alert" className="px-3 pb-2 text-xs text-red-600">
            {warning}
          </p>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={SUPPORTED_DOCUMENT_ACCEPT}
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            onAddFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <div className="flex items-center justify-between gap-1 px-2 pb-2">
          {messaging ? (
            // Messages to the requester carry text only.
            <span />
          ) : (
            <button
              type="button"
              disabled={locked}
              onClick={() => (onBrowse ? onBrowse() : input.current?.click())}
              className={cn(
                TEXT_BUTTON_CLASS,
                "inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-900 disabled:opacity-60",
              )}
            >
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
              Add documents
            </button>
          )}
          <div className="flex items-center gap-1">
            {/* Resolving saves any comment as the resolution; none is needed. */}
            {onResolve && !messaging && (
              <button
                type="button"
                disabled={locked}
                onClick={onResolve}
                className={cn(
                  TEXT_BUTTON_CLASS,
                  "text-gray-500 hover:text-gray-900 disabled:opacity-60",
                )}
              >
                Resolve request
              </button>
            )}
            <button
              type="button"
              disabled={!note.trim() || locked}
              onClick={onSubmit}
              className={cn(
                TEXT_BUTTON_CLASS,
                "font-medium text-gray-900 hover:text-black disabled:text-gray-400",
              )}
            >
              {messaging ? "Ask requester" : "Submit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The documents added with a note, tagged under its text. Ready documents
 * open in the viewer; the rest say how far along they are.
 */
export function IntakeNoteDocuments({
  documents,
  uploading,
  onOpen,
}: {
  documents: IntakeDocument[];
  uploading: IntakeUpload[];
  onOpen: (documentId: string) => void;
}) {
  if (!documents.length && !uploading.length) return null;
  return (
    <ul
      aria-label="Documents added with the note"
      className="flex flex-wrap gap-1.5"
    >
      {documents.map((document) => {
        const ready = document.status === "ready";
        const failed = document.status === "error";
        return (
          <li key={document.document_id} className="min-w-0">
            <DocumentPill
              filename={document.filename}
              fileType={document.file_type}
              icon={ready || failed ? undefined : <IntakeDocumentSpinner />}
              status={
                ready ? undefined : failed ? "Couldn't process" : "Processing"
              }
              tone={failed ? "error" : "default"}
              onOpen={ready ? () => onOpen(document.document_id) : undefined}
            />
          </li>
        );
      })}
      {uploading.map((upload, index) => (
        <li key={`${upload.file.name}:${index}`} className="min-w-0">
          <DocumentPill
            filename={upload.file.name}
            icon={<IntakeDocumentSpinner />}
            status="Uploading"
          />
        </li>
      ))}
    </ul>
  );
}
