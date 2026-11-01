import type { IntakeDocument } from "@mike/contracts";
import {
  copyDocumentVersionFiles,
  createDocumentVersion,
} from "../documents/documents.service";
import { ensureDocAccess } from "../../lib/access";
import { contentSha256 } from "../../lib/documentVersions";
import { findDocumentsOutsideWorkspace } from "../../lib/documentWorkspace";
import { convertedPdfKey } from "../../lib/convert";
import {
  deleteFileBestEffort,
  downloadFile,
  storageKey,
} from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { attachIntakeDocument, listIntakeDocuments } from "./intake.documents";
import type { IntakeScope } from "./intake.requests";
import { intakeRpc } from "./intake.shared";

type SourceDocument = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  org_id: string | null;
  workflow_id: string | null;
  status: string | null;
  current_version_id: string | null;
};

/**
 * Copy documents the actor can already read, such as files from their
 * library, onto a request, and onto the actor's note or resolution when
 * `messageId` names one. Each copy is the request's own attachment: the
 * source is untouched, and editing or deleting either never affects the
 * other. Sources must come from the request's workspace, as a project's do,
 * and have finished processing.
 *
 * `workspaceOrgId` is the organization whose documents may be copied, or
 * null in the actor's Personal workspace.
 */
export async function copyIntakeDocuments(
  db: Db,
  scope: IntakeScope & { userEmail?: string | null },
  requestId: string,
  documentIds: string[],
  messageId: string | null,
  workspaceOrgId: string | null,
): Promise<ServiceResult<IntakeDocument[]>> {
  const readable = await intakeRpc<boolean>(db, "intake_can_read", {
    p_org: scope.orgId,
    p_actor: scope.actorId,
    p_request: requestId,
  });
  if (!readable.ok) return readable;
  if (!readable.data) return failure("not_found", "Request not found.");

  const ids = [...new Set(documentIds)];
  const { data, error } = await db
    .from("documents")
    .select(
      "id, user_id, project_id, org_id, workflow_id, status, current_version_id",
    )
    .in("id", ids);
  if (error) return internalFailure(error);
  const sources = (data ?? []) as SourceDocument[];
  if (sources.length !== ids.length)
    return failure("not_found", "Document not found.");
  for (const source of sources) {
    const access = await ensureDocAccess(
      source,
      scope.actorId,
      scope.userEmail,
      db,
    );
    if (!access.ok) return failure("not_found", "Document not found.");
  }
  try {
    const outside = await findDocumentsOutsideWorkspace(
      db,
      ids,
      workspaceOrgId,
    );
    if (outside.length > 0)
      return failure(
        "validation",
        "Choose documents from this workspace.",
        "workspace_mismatch",
      );
  } catch (cause) {
    return internalFailure(cause);
  }
  // Nothing here would finish a source's processing for its copy.
  if (sources.some((source) => source.status !== "ready"))
    return failure(
      "validation",
      "Only documents that have finished processing can be copied.",
    );

  // Copied in the order chosen, so a failure part way leaves the earlier
  // copies attached and says which ones remain.
  for (const id of ids) {
    const source = sources.find((s) => s.id === id)!;
    const copied = await copyOne(db, scope, requestId, source, messageId);
    if (!copied.ok) return copied;
  }
  return listIntakeDocuments(db, scope, requestId);
}

async function copyOne(
  db: Db,
  scope: IntakeScope,
  requestId: string,
  source: SourceDocument,
  messageId: string | null,
): Promise<ServiceResult<null>> {
  if (!source.current_version_id)
    return failure("validation", "That document has no file yet.");
  const { data: version, error: versionError } = await db
    .from("document_versions")
    .select(
      "storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count, textless_page_count",
    )
    .eq("id", source.current_version_id)
    .single();
  if (versionError || !version?.storage_path)
    return failure("validation", "That document has no file yet.");
  const bytes = await downloadFile(version.storage_path as string);
  if (!bytes) return internalFailure(new Error("Could not read the document"));

  const { data: copy, error: insertError } = await db
    .from("documents")
    .insert({
      user_id: scope.actorId,
      org_id: scope.orgId,
      // Ready once its version exists, as an upload is.
      status: "processing",
      library_kind: "intake_attachment",
    })
    .select("id")
    .single();
  if (insertError || !copy) return internalFailure(insertError);
  const copyId = copy.id as string;
  // Linked before any bytes are copied, as an upload is, so the copy is
  // never ownerless; a request deleted meanwhile takes it with it.
  const attached = await attachIntakeDocument(
    db,
    scope,
    requestId,
    copyId,
    messageId,
  );
  if (!attached.ok) {
    await db.from("documents").delete().eq("id", copyId);
    return attached;
  }

  const filename =
    (version.filename as string | null)?.trim() || "Untitled document";
  const fileType = version.file_type as string | null;
  const key = storageKey(scope.actorId, copyId, filename);
  let pdfPath: string | null = null;
  try {
    ({ pdfStoragePath: pdfPath } = await copyDocumentVersionFiles({
      source: {
        storage_path: version.storage_path as string,
        pdf_storage_path: version.pdf_storage_path as string | null,
        file_type: fileType,
      },
      storagePath: key,
      pdfStoragePath: convertedPdfKey(scope.actorId, copyId),
      transport: "download",
      rendition: "optional",
      sourceBytes: bytes,
    }));
    const { error: createError } = await createDocumentVersion(db, {
      document_id: copyId,
      storage_path: key,
      pdf_storage_path: pdfPath,
      source: (version.source as string | null) ?? "upload",
      version_number: (version.version_number as number | null) ?? 1,
      filename,
      file_type: fileType,
      size_bytes: (version.size_bytes as number | null) ?? null,
      page_count: (version.page_count as number | null) ?? null,
      textless_page_count: (version.textless_page_count as number | null) ?? null,
      content_sha256: contentSha256(bytes),
    });
    if (createError) throw createError;
    const { error: readyError } = await db
      .from("documents")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", copyId);
    if (readyError) throw readyError;
    return ok(null);
  } catch (cause) {
    await Promise.all([
      deleteFileBestEffort(key, "intake-copy-rollback"),
      pdfPath && pdfPath !== key
        ? deleteFileBestEffort(pdfPath, "intake-copy-rollback")
        : Promise.resolve(),
      db.from("documents").delete().eq("id", copyId),
    ]);
    return internalFailure(cause);
  }
}
