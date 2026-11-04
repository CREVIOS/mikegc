import type { Db } from "../../lib/supabase";
import { intakeRequestWorkspace } from "../intake/intake.service";

/**
 * The intake request a message's pill links its chat to: once, for someone
 * who can read the request, in a chat of its own (outside any project) in
 * the request's workspace. Null when there is nothing new to link.
 */
export async function resolvePilledIntake(
    db: Db,
    args: {
        userId: string;
        /** The request the newest user message's pill names. */
        pilled: string | null;
        /** The request the chat already works on. */
        linked: string | null;
        projectId: string | null;
        /** The organization the chat belongs to; null is personal. */
        chatOrgId: string | null;
    },
): Promise<
    | { ok: true; link: string | null }
    | { ok: false; status: number; detail: string }
    | { ok: false; internal: true; error: unknown }
> {
    const { pilled, linked } = args;
    if (!pilled || pilled === linked) return { ok: true, link: null };
    if (linked || args.projectId)
        return {
            ok: false,
            status: 400,
            detail: "Process an intake request in a new chat of its own.",
        };
    const workspace = await intakeRequestWorkspace(db, args.userId, pilled);
    if (!workspace.ok)
        return workspace.kind === "error"
            ? { ok: false, internal: true, error: workspace.error }
            : { ok: false, status: 404, detail: "Request not found." };
    const requestOrg = workspace.data.personal ? null : workspace.data.orgId;
    if (args.chatOrgId !== requestOrg)
        return {
            ok: false,
            status: 400,
            detail: "Open the request's workspace to process it in the Assistant.",
        };
    return { ok: true, link: pilled };
}
