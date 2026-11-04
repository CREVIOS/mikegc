"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type {
  IntakeNotification,
  IntakeNotificationClaim,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useLatestRef } from "@/app/hooks/useLatestRef";
import { claimIntakeNotifications } from "@/app/lib/mikeApi";
import { showToast } from "@/app/components/ui/toast";
import {
  INTAKE_NOTIFICATION_TOAST_MS,
  announceIntakeNotifications,
  planIntakeNotificationToasts,
  type IntakeNotificationToast,
} from "./intakeNotifications";

/** How often an open, visible tab checks for news. */
export const INTAKE_NOTIFICATION_POLL_MS = 30_000;
/** A failing check waits longer each time, up to this. */
export const INTAKE_NOTIFICATION_MAX_BACKOFF_MS = 5 * 60_000;
/** Coming back to the tab checks at once, unless it just did. */
const MIN_CHECK_GAP_MS = 5_000;

/**
 * The account's check in flight, if any. A claim hands notifications over
 * only once, so a remount while one is in flight (React's development
 * double-mount, or the layout mounting again) waits for the same claim
 * instead of starting a second one that would find nothing left.
 */
let inFlightClaim: {
  accountId: string;
  promise: Promise<IntakeNotificationClaim>;
} | null = null;

function claimFor(accountId: string) {
  if (inFlightClaim?.accountId === accountId) return inFlightClaim.promise;
  const promise = claimIntakeNotifications().finally(() => {
    if (inFlightClaim?.promise === promise) inFlightClaim = null;
  });
  inFlightClaim = { accountId, promise };
  return promise;
}

function IntakeNotificationMessage({
  toast,
}: {
  toast: IntakeNotificationToast;
}) {
  // "Supplier NDA: Sam Patel assigned it to you", the subject in bold.
  return (
    <span className="block" data-testid="intake-notification-line">
      {toast.subject ? (
        <span className="font-semibold text-gray-500">{toast.subject}: </span>
      ) : null}
      <span className="text-gray-600">{toast.line}</span>
    </span>
  );
}

/**
 * Toasts for the signed-in member about the intake requests assigned to
 * them: "New Intake Request" when one becomes theirs, "Intake request
 * update" when someone else, MikeGC or the requester changes one. While the
 * tab is visible it checks every 30 seconds, and at once when the tab comes
 * back. A check that fails says nothing and tries again later. Mount once,
 * inside the workspace provider.
 */
export function IntakeNotifications() {
  const { accountId, workspaceId } = useWorkspace();
  const router = useRouter();
  const context = useLatestRef({ accountId, workspaceId, router });

  useEffect(() => {
    if (!accountId) return;
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = INTAKE_NOTIFICATION_POLL_MS;
    let lastCheck = 0;
    const hidden = () => document.visibilityState === "hidden";

    const show = (notifications: IntakeNotification[]) => {
      const { workspaceId: open, router: navigate } = context.current;
      for (const toast of planIntakeNotificationToasts(notifications, {
        workspaceId: open,
        accountId,
      })) {
        const action = toast.action;
        showToast({
          tone: "info",
          title: toast.title,
          message: <IntakeNotificationMessage toast={toast} />,
          durationMs: INTAKE_NOTIFICATION_TOAST_MS,
          dedupeKey: toast.key,
          actions: action
            ? [
                {
                  label: action.label,
                  tone: "blue",
                  onClick: () => navigate.push(action.href),
                },
              ]
            : undefined,
        });
      }
      announceIntakeNotifications(notifications);
    };

    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      stop();
      if (!disposed && !hidden()) timer = setTimeout(() => void check(), delay);
    };
    const check = async () => {
      if (disposed || inFlight || hidden()) return;
      inFlight = true;
      lastCheck = Date.now();
      try {
        const { notifications } = await claimFor(accountId);
        delay = INTAKE_NOTIFICATION_POLL_MS;
        if (!disposed && notifications.length) show(notifications);
      } catch {
        // A background check never interrupts the member; it waits longer.
        delay = Math.min(delay * 2, INTAKE_NOTIFICATION_MAX_BACKOFF_MS);
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const wake = () => {
      if (hidden()) return stop();
      if (inFlight) return;
      if (Date.now() - lastCheck >= MIN_CHECK_GAP_MS) return void check();
      if (timer === null) schedule();
    };

    void check();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [accountId, context]);

  return null;
}
