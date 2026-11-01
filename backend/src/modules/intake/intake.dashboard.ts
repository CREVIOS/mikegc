import type { IntakeDashboard } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import type { IntakeScope } from "./intake.requests";
import { intakeRpc } from "./intake.shared";

/**
 * Where the organization's requests stand, with weeks counted from Monday in
 * the viewer's timezone. Any member may read it.
 */
export function getIntakeDashboard(
  db: Db,
  scope: IntakeScope,
  timezone: string,
  periods: {
    weeks: number;
    created_days: number;
    resolved_days: number;
    median_days: number;
  },
) {
  return intakeRpc<IntakeDashboard>(db, "intake_dashboard", {
    p_org: scope.orgId,
    p_actor: scope.actorId,
    p_timezone: timezone,
    p_weeks: periods.weeks,
    p_created_days: periods.created_days,
    p_resolved_days: periods.resolved_days,
    p_median_days: periods.median_days,
  });
}
