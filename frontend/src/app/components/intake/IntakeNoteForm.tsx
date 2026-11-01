"use client";

import { useRef, type Ref } from "react";
import { Paperclip } from "lucide-react";
import type { IntakeDocument } from "@mike/contracts";
import { cn } from "@/app/lib/utils";
import { DocumentPill } from "@/app/components/shared/DocumentPill";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import { INTAKE_TEXTAREA_CLASS } from "./IntakeDetailsPanel";
import { IntakeDocumentSpinner, type IntakeUpload } from "./IntakeDocuments";

const TEXT_BUTTON_CLASS =
  "rounded-md px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

/**
 * Writes a note, with documents to add alongside it: chosen here or dropped
 * on the box. The page uploads them once the note is saved, so they are
 * tagged on the note and listed with the request's documents.
 */
export function IntakeNoteForm({
  boxRef,
  note,
  files,
  warning,
  dropping,
  locked,
  autoFocus,
  onNoteChange,
  onAddFiles,
  onRemoveFile,
  onCancel,
  onSubmit,
}: {
  /** The box the page treats as the note's drop target. */
  boxRef: Ref<HTMLDivElement>;
  note: string;
  files: File[];
  warning: string | null;
  /** Files are being dragged over the box. */
  dropping: boolean;
  locked: boolean;
  autoFocus: boolean;
  onNoteChange: (note: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="border-t border-gray-100 p-5">
      <label
        htmlFor="intake-note"
        className="mb-2 block text-sm font-medium text-gray-700"
      >
        Add a note
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
          placeholder="What happened, what the requester said, what was sent"
          value={note}
          autoFocus={autoFocus}
          disabled={locked}
          onChange={(e) => onNoteChange(e.target.value)}
        />
        {files.length > 0 && (
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
          <button
            type="button"
            disabled={locked}
            onClick={() => input.current?.click()}
            className={cn(
              TEXT_BUTTON_CLASS,
              "inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-900 disabled:opacity-60",
            )}
          >
            <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
            Add documents
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={locked}
              onClick={onCancel}
              className={cn(
                TEXT_BUTTON_CLASS,
                "text-gray-500 hover:text-gray-900 disabled:opacity-60",
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!note.trim() || locked}
              onClick={onSubmit}
              className={cn(
                TEXT_BUTTON_CLASS,
                "font-medium text-gray-900 hover:text-black disabled:text-gray-400",
              )}
            >
              Submit
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
