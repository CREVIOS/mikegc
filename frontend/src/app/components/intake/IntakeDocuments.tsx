"use client";

import { useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { IntakeDocument } from "@mike/contracts";
import type { Document } from "@/app/components/shared/types";
import {
  getDocument,
  getDocumentUrl,
  uploadIntakeDocuments,
} from "@/app/lib/mikeApi";
import { notifyError, notifyPartialFailure } from "@/app/lib/userFacingError";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { IntakeUploadPrompt } from "./IntakeDocumentDropZone";
import { LIQUID_GLASS_MODAL_ROW_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import { DocumentSidePanel } from "@/app/components/shared/DocumentSidePanel";

const noop = () => {};

/**
 * The file directory's columns. Narrow cards keep the name and size; the
 * date and who added the file join as the card widens.
 */
const DOCUMENT_GRID_CLASS =
  "grid grid-cols-[14px_minmax(0,1fr)_64px] items-center gap-2 @[30rem]:grid-cols-[14px_minmax(0,1fr)_84px_64px] @[40rem]:grid-cols-[14px_minmax(0,1fr)_minmax(0,8rem)_84px_64px]";
const ADDED_BY_CELL_CLASS = "hidden truncate @[40rem]:block";
const ADDED_CELL_CLASS = "hidden truncate @[30rem]:block";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAdded(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** A file on its way to a request, and the note it was added with, if any. */
export type IntakeUpload = { file: File; messageId: string | null };

/**
 * Uploads files to a request. The upload worker links each document to the
 * request, and to the note it was added with, so the caller only reloads the
 * list afterwards. Uploads from the documents field and from notes can run at
 * the same time.
 */
export function useIntakeDocumentUpload(
  orgId: string,
  requestId: string,
  onChanged: () => void,
) {
  const [uploading, setUploading] = useState<IntakeUpload[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  async function add(candidates: File[], messageId: string | null = null) {
    const { supported, unsupported } =
      partitionSupportedDocumentFiles(candidates);
    if (!messageId) setWarning(formatUnsupportedDocumentWarning(unsupported));
    if (!supported.length) return;
    const batch = supported.map((file) => ({ file, messageId }));
    setUploading((current) => [...current, ...batch]);
    try {
      const files = supported.map((file) => ({ file }));
      const outcomes = await (messageId
        ? uploadIntakeDocuments(orgId, requestId, files, { messageId })
        : uploadIntakeDocuments(orgId, requestId, files));
      const failed = outcomes.filter(
        (outcome) => outcome.status !== "completed",
      ).length;
      if (failed)
        notifyPartialFailure(
          messageId
            ? `The note was added, but ${failed} of ${supported.length} documents couldn't be uploaded. Add them to the request's documents instead.`
            : `${failed} of ${supported.length} documents couldn't be uploaded. Try adding them again.`,
          { action: "upload the documents" },
        );
    } catch (error) {
      notifyError(error, { action: "upload the documents" });
    } finally {
      setUploading((current) =>
        current.filter((upload) => !batch.includes(upload)),
      );
      onChanged();
    }
  }

  return { uploading, warning, add };
}

/**
 * Opens a request's documents in the document viewer. The documents section
 * and the notes they were added with share one viewer.
 */
export function useIntakeDocumentViewer() {
  const [viewing, setViewing] = useState<Document | null>(null);

  async function open(documentId: string) {
    try {
      setViewing(await getDocument(documentId));
    } catch (error) {
      notifyError(error, { action: "open the document" });
    }
  }

  async function download(documentId: string, versionId?: string) {
    try {
      const { url, filename } = await getDocumentUrl(documentId, versionId);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
    } catch (error) {
      notifyError(error, { action: "download the document" });
    }
  }

  const panel = (
    <DocumentSidePanel
      doc={viewing}
      readOnly
      versions={[]}
      versionsLoading={false}
      canDelete={false}
      onClose={() => setViewing(null)}
      onLoadVersions={noop}
      onSelectVersion={noop}
      onDownloadDocument={(documentId) => download(documentId)}
      onDownloadVersion={(documentId, versionId) =>
        download(documentId, versionId)
      }
      onRenameVersion={noop}
      onDeleteVersion={noop}
      onUploadNewVersion={async () => {}}
      onReplaceVersion={noop}
      onDelete={noop}
    />
  );

  return { open, panel };
}

/**
 * A request's documents as rows like the file directory's, above a grey field
 * that adds more; files can also be dropped anywhere on the page. Every member
 * of the organization can open them in the document viewer and add more.
 */
export function IntakeDocuments({
  documents,
  uploading,
  warning,
  onAdd,
  onOpen,
}: {
  documents: IntakeDocument[];
  uploading: File[];
  warning: string | null;
  onAdd: (files: File[]) => void;
  onOpen: (documentId: string) => void;
}) {
  const heading = useId();
  const input = useRef<HTMLInputElement>(null);
  const busy = uploading.length > 0;
  const spinner = <IntakeDocumentSpinner />;
  const rows = documents.length + uploading.length;

  return (
    <section aria-labelledby={heading} className="@container">
      <h2 id={heading} className="mb-2 text-sm font-medium text-gray-900">
        Documents
      </h2>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={SUPPORTED_DOCUMENT_ACCEPT}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onAdd(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {rows > 0 && (
        <div className="-mx-2 mb-3 text-xs">
          <div
            aria-hidden="true"
            className={`${DOCUMENT_GRID_CLASS} px-2 pb-1 pt-0.5 text-[11px] font-medium text-gray-400`}
          >
            <span className="col-span-2">Name</span>
            <span className={ADDED_BY_CELL_CLASS}>Added by</span>
            <span className={ADDED_CELL_CLASS}>Added</span>
            <span className="text-right">Size</span>
          </div>
          <ul>
            {documents.map((document) => {
              const ready = document.status === "ready";
              const cells = (
                <>
                  <FileTypeIcon fileType={document.file_type} />
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-gray-700">
                      {document.filename}
                    </span>
                    {!ready && (
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 ${document.status === "error" ? "text-red-600" : "text-gray-400"}`}
                      >
                        {document.status === "error" ? null : spinner}
                        {document.status === "error"
                          ? "Couldn't process"
                          : "Processing"}
                      </span>
                    )}
                  </span>
                  <span className={`${ADDED_BY_CELL_CLASS} text-gray-400`}>
                    {document.added_by_name}
                  </span>
                  <span className={`${ADDED_CELL_CLASS} text-gray-400`}>
                    {formatAdded(document.created_at)}
                  </span>
                  <span className="truncate text-right text-gray-400">
                    {document.size_bytes == null
                      ? "--"
                      : formatSize(document.size_bytes)}
                  </span>
                </>
              );
              return (
                <li key={document.document_id}>
                  {ready ? (
                    <button
                      type="button"
                      aria-label={`Open ${document.filename}`}
                      title={document.filename}
                      onClick={() => onOpen(document.document_id)}
                      className={`w-full rounded-md ${DOCUMENT_GRID_CLASS} px-2 py-2 text-left transition-all ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40`}
                    >
                      {cells}
                    </button>
                  ) : (
                    <div
                      title={document.filename}
                      className={`${DOCUMENT_GRID_CLASS} px-2 py-2`}
                    >
                      {cells}
                    </div>
                  )}
                </li>
              );
            })}
            {uploading.map((file, index) => (
              <li
                key={`${file.name}:${index}`}
                title={file.name}
                className={`${DOCUMENT_GRID_CLASS} px-2 py-2`}
              >
                <FileTypeIcon fileType={file.name} />
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-gray-700">
                    {file.name}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-gray-400">
                    {spinner}
                    Uploading
                  </span>
                </span>
                <span className={`${ADDED_BY_CELL_CLASS} text-gray-400`}>
                  --
                </span>
                <span className={`${ADDED_CELL_CLASS} text-gray-400`}>--</span>
                <span className="truncate text-right text-gray-400">
                  {formatSize(file.size)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        aria-busy={busy}
        className={`rounded-xl bg-gray-100 ${rows ? "p-2" : "p-4"}`}
      >
        {busy ? (
          <p
            className="py-1.5 text-center text-xs text-gray-500"
            aria-live="polite"
          >
            {uploading.length === 1
              ? "Uploading 1 document…"
              : `Uploading ${uploading.length} documents…`}
          </p>
        ) : rows ? (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="w-full rounded-lg py-1.5 text-center text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Drop more documents here, or click to add more.
          </button>
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="w-full rounded-lg py-4 text-center text-sm text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <IntakeUploadPrompt />
          </button>
        )}
        {warning && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {warning}
          </p>
        )}
      </div>
    </section>
  );
}

/** A document still uploading or being processed. */
export function IntakeDocumentSpinner() {
  return (
    <Loader2
      aria-hidden="true"
      className="h-3 w-3 animate-spin motion-reduce:animate-none"
    />
  );
}
