"use client";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import type { Document } from "@/app/components/shared/types";

/** A library document chosen for a request, before it is copied there. */
export type IntakePickedDocument = { id: string; filename: string };

/**
 * The app's Add documents modal for intake: pick files from the library or
 * upload new ones. Picked documents are copied onto the request by the
 * caller, so the originals stay where they are.
 */
export function IntakeDocumentPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (documents: IntakePickedDocument[]) => void;
}) {
  return (
    <AddDocumentsModal
      open={open}
      onClose={onClose}
      breadcrumb={["Intake", "Add documents"]}
      tabs={["files"]}
      uploadStateId="intake-documents"
      onSelect={(documents: Document[]) => {
        onClose();
        if (documents.length)
          onPick(documents.map(({ id, filename }) => ({ id, filename })));
      }}
    />
  );
}
