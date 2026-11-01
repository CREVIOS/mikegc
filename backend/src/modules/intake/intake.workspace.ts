import type { Db } from "../../lib/supabase";
import {
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

/**
 * How intake paths and uploads name the caller's own Personal workspace. Its
 * organization is behind the scenes (lib/personalOrgs.ts), so clients never
 * learn its id; the server resolves it for whoever is asking.
 */
export const PERSONAL_INTAKE = "personal";

/**
 * The organization that holds the caller's own requests: their personal
 * organization, made now if the account predates it. Every account has one,
 * with the account as its only member.
 */
export async function personalIntakeOrgId(
  db: Db,
  actorId: string,
): Promise<ServiceResult<string>> {
  const { data, error } = await db
    .from("organizations")
    .select("id")
    .eq("personal_user_id", actorId)
    .eq("kind", "personal")
    .maybeSingle();
  if (error)
    return internalFailure(new Error("Failed to read the personal organization"));
  const existing = (data as { id?: string } | null)?.id;
  if (existing) return ok(existing);
  const made = await db.rpc("ensure_personal_organization", {
    p_user_id: actorId,
  });
  if (made.error || typeof made.data !== "string")
    return internalFailure(
      new Error("Failed to create the personal organization"),
    );
  return ok(made.data);
}

/**
 * The organization an intake path or upload names: a team organization's id
 * as given, or the caller's personal organization for "personal". SQL still
 * checks that the caller belongs to it.
 */
export async function resolveIntakeOrg(
  db: Db,
  actorId: string,
  workspace: string,
): Promise<ServiceResult<string>> {
  return workspace === PERSONAL_INTAKE
    ? personalIntakeOrgId(db, actorId)
    : ok(workspace);
}
