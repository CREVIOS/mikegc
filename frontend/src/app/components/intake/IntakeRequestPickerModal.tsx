"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { IntakeRequestSummary } from "@mike/contracts";
import { Modal } from "@/app/components/modals/Modal";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
  LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
  LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { listIntakeRequests } from "@/app/lib/mikeApi";
import { intakeStateLabel } from "./intakeLabels";

/** A request picked to process: `orgId` is its workspace, or "personal". */
export type PickedIntakeRequest = { id: string; title: string; orgId: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (request: PickedIntakeRequest) => void;
  breadcrumbs: ReactNode[];
};

/**
 * Picks one of the active workspace's open intake requests to process in
 * the Assistant; laid out like the playbook picker. Search runs on the
 * server, so it reaches past the first page of the queue.
 */
export function IntakeRequestPickerModal({
  open,
  onClose,
  onSelect,
  breadcrumbs,
}: Props) {
  const { workspaceId } = useWorkspace();
  const [requests, setRequests] = useState<IntakeRequestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<IntakeRequestSummary | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    // Wait for typing to pause before asking the server.
    const timer = setTimeout(
      () => {
        setLoading(true);
        setFailed(false);
        listIntakeRequests(workspaceId, {
          scope: "open",
          search: search.trim() || undefined,
        })
          .then((page) => {
            if (cancelled) return;
            setRequests(page.requests);
            setSelected((current) =>
              current && page.requests.some((r) => r.id === current.id)
                ? current
                : null,
            );
          })
          .catch(() => {
            if (cancelled) return;
            setRequests([]);
            setFailed(true);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, search, workspaceId]);

  if (!open) return null;

  function close() {
    setSelected(null);
    setSearch("");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      breadcrumbs={breadcrumbs}
      primaryAction={{
        label: "Use",
        disabled: !selected || !workspaceId,
        onClick: () => {
          if (!selected || !workspaceId) return;
          onSelect({
            id: selected.id,
            title: selected.subject,
            orgId: workspaceId,
          });
          close();
        },
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-visible">
        <SearchBar
          value={search}
          onValueChange={setSearch}
          placeholder="Search open requests..."
        />
        <div
          data-modal-scroll="vertical"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-sm pt-2"
        >
          {loading && requests.length === 0 ? (
            <div className="space-y-px">
              {[60, 45, 75, 50, 65].map((width) => (
                <div
                  key={width}
                  className="flex items-center rounded-md px-3 py-2.5"
                >
                  <div
                    className="h-3 animate-pulse rounded bg-gray-100"
                    style={{ width: `${width}%` }}
                  />
                </div>
              ))}
            </div>
          ) : requests.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              {failed
                ? "Requests couldn’t be loaded. Try again later."
                : search.trim()
                  ? "No matches found"
                  : "No open requests"}
            </p>
          ) : (
            <div className="space-y-px">
              {requests.map((request) => {
                const isSelected = selected?.id === request.id;
                return (
                  <button
                    key={request.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelected(isSelected ? null : request)}
                    className={`flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-3 py-2 text-left text-xs transition-all ${
                      isSelected
                        ? `${LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS} text-gray-900`
                        : LIQUID_GLASS_MODAL_ROW_HOVER_CLASS
                    }`}
                  >
                    <span
                      className={`min-w-0 flex-1 basis-48 [overflow-wrap:anywhere] ${
                        isSelected ? "font-medium text-gray-900" : "text-gray-700"
                      }`}
                    >
                      {request.subject}
                    </span>
                    <span className="shrink-0 text-gray-400">
                      {[
                        request.requester_name,
                        intakeStateLabel(request.state, request.clarify_stage),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
