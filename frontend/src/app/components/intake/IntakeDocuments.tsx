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
import { DocumentPill } from "@/app/components/shared/DocumentPill";
import { DocumentSidePanel } from "@/app/components/shared/DocumentSidePanel";

const noop = () => {};

/**
 * Uploads files to a request. The upload worker links each document to the
 * request, so the caller only reloads the list afterwards.
 */
export function useIntakeDocumentUpload(
  orgId: string,
  requestId: string,
  onChanged: () => void,
) {
  const [uploading, setUploading] = useState<File[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  async function add(candidates: File[]) {
    const { supported, unsupported } =
      partitionSupportedDocumentFiles(candidates);
    setWarning(formatUnsupportedDocumentWarning(unsupported));
    if (!supported.length || uploading.length) return;
    setUploading(supported);
    try {
      const outcomes = await uploadIntakeDocuments(
        orgId,
        requestId,
        supported.map((file) => ({ file })),
      );
      const failed = outcomes.filter(
        (outcome) => outcome.status !== "completed",
      ).length;
      if (failed)
        notifyPartialFailure(
          `${failed} of ${supported.length} documents couldn't be uploaded. Try adding them again.`,
          { action: "upload the documents" },
        );
    } catch (error) {
      notifyError(error, { action: "upload the documents" });
    } finally {
      setUploading([]);
      onChanged();
    }
  }

  return { uploading, warning, add };
}

/**
 * A request's documents in a grey field like the playbook run's: click it to
 * add files, or drop them anywhere on the page. Every member of the
 * organization can open them in the document viewer and add more.
 */
export function IntakeDocuments({
  documents,
  uploading,
  warning,
  onAdd,
}: {
  documents: IntakeDocument[];
  uploading: File[];
  warning: string | null;
  onAdd: (files: File[]) => void;
}) {
  const heading = useId();
  const input = useRef<HTMLInputElement>(null);
  const [viewing, setViewing] = useState<Document | null>(null);
  const busy = uploading.length > 0;

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

  const spinner = (
    <Loader2
      aria-hidden="true"
      className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none"
    />
  );

  return (
    <section aria-labelledby={heading}>
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
      <div aria-busy={busy} className="rounded-xl bg-gray-100 p-4">
        {documents.length || busy ? (
          <>
            {busy ? (
              <p className="mb-3 text-xs text-gray-500" aria-live="polite">
                {uploading.length === 1
                  ? "Uploading 1 document…"
                  : `Uploading ${uploading.length} documents…`}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="mb-3 block rounded-md text-left text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Drop more documents here, or click to add more.
              </button>
            )}
            <ul className="flex flex-wrap gap-1.5">
              {documents.map((document) => (
                <li key={document.document_id} className="min-w-0">
                  <DocumentPill
                    filename={document.filename}
                    fileType={document.file_type}
                    icon={document.status === "ready" ? undefined : spinner}
                    status={
                      document.status === "ready"
                        ? undefined
                        : document.status === "error"
                          ? "Couldn't process"
                          : "Processing"
                    }
                    tone={document.status === "error" ? "error" : "default"}
                    onOpen={
                      document.status === "ready"
                        ? () => void open(document.document_id)
                        : undefined
                    }
                  />
                </li>
              ))}
              {uploading.map((file, index) => (
                <li key={`${file.name}:${index}`} className="min-w-0">
                  <DocumentPill
                    filename={file.name}
                    icon={spinner}
                    status="Uploading"
                  />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="w-full rounded-lg py-4 text-center text-sm text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Drag and drop documents here, or click to browse. PDF, Word, Excel
            and PowerPoint files are supported.
          </button>
        )}
        {warning && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {warning}
          </p>
        )}
      </div>
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
    </section>
  );
}
