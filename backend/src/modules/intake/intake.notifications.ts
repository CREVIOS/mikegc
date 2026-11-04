import type {
  IntakeChannel,
  IntakeNotification,
  IntakeNotificationChange,
  IntakeNotificationClaim,
} from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import { ok, type ServiceResult } from "../../lib/serviceResult";
import { intakeRpc } from "./intake.shared";

/** One notification as the database hands it over, oldest first. */
export interface ClaimedIntakeNotification {
  id: number;
  workspace: string;
  workspace_name: string;
  request_id: string;
  subject: string;
  kind: IntakeNotification["kind"];
  change: IntakeNotificationChange;
  actor_name: string | null;
  automated: boolean;
  channel: IntakeChannel | null;
  /** The change's transaction time, shared by everything it wrote. */
  created_at: string;
}

/**
 * Hands the signed-in member the notifications waiting for them in every
 * workspace and deletes them, so each toast is shown once. The database
 * drops any that are no longer theirs; several changes to one request
 * arrive as one notification.
 */
export async function claimIntakeNotifications(
  db: Db,
  actorId: string,
): Promise<ServiceResult<IntakeNotificationClaim>> {
  const result = await intakeRpc<ClaimedIntakeNotification[] | null>(
    db,
    "intake_claim_notifications",
    { p_actor: actorId },
  );
  if (!result.ok) return result;
  return ok({ notifications: groupIntakeNotifications(result.data ?? []) });
}

/**
 * One notification per request, newest last. A request that became the
 * member's is new to them whatever else happened; otherwise the latest change
 * is described by what it was for (the reply rather than the request going
 * back to work because of it, the edit rather than MikeGC stopping asking),
 * which is the first thing that change wrote. `more` counts the other changes.
 */
export function groupIntakeNotifications(
  rows: readonly ClaimedIntakeNotification[],
): IntakeNotification[] {
  const groups = new Map<string, ClaimedIntakeNotification[]>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const key = `${row.workspace}:${row.request_id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()]
    .sort((a, b) => a[a.length - 1].id - b[b.length - 1].id)
    .map((group) => {
      const latest = group[group.length - 1];
      const changes = new Set(group.map((row) => row.created_at)).size;
      const headline =
        [...group].reverse().find((row) => row.kind === "new_request") ??
        group.find((row) => row.created_at === latest.created_at)!;
      return {
        workspace: latest.workspace,
        workspace_name: latest.workspace_name,
        request_id: latest.request_id,
        subject: latest.subject,
        kind: headline.kind,
        change: headline.change,
        actor_name: headline.actor_name,
        automated: headline.automated,
        channel: headline.channel,
        more: changes - 1,
        created_at: latest.created_at,
      };
    });
}

/**
 * Deletes notifications nobody collected within a day; they are never shown.
 * Run by the stale-work sweep.
 */
export async function expireIntakeNotifications(db: Db): Promise<number> {
  const { data, error } = await db.rpc("intake_expire_notifications");
  if (error) throw error;
  return Number(data ?? 0);
}
