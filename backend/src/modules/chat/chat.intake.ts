import type { Db } from "../../lib/supabase";
import { intakeRequestWorkspace } from "../intake/intake.service";

const NEW_CHAT_ONLY = {
    ok: false as const,
    status: 400,
    detail: "Process an intake request in a new chat of its own.",
};

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
        /** The existing chat this turn is sent to; null starts one. */
        chatId: string | null;
    },
): Promise<
    | { ok: true; link: string | null }
    | { ok: false; status: number; detail: string }
    | { ok: false; internal: true; error: unknown }
> {
    const { pilled, linked } = args;
    if (!pilled || pilled === linked) return { ok: true, link: null };
    if (linked || args.projectId) return NEW_CHAT_ONLY;
    if (args.chatId) {
        // A chat that already holds a conversation stays about that
        // conversation: only a chat with no messages yet takes a request.
        const { data, error } = await db
            .from("chat_messages")
            .select("id")
            .eq("chat_id", args.chatId)
            .limit(1);
        if (error) return { ok: false, internal: true, error };
        if ((data ?? []).length > 0) return NEW_CHAT_ONLY;
    }
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

/**
 * Links an existing chat to the request its first message's pill names.
 * Another send can link the chat first: that is fine when it named the same
 * request, and a conflict when it named another, since this turn would
 * otherwise read one request's brief while the chat stays on the other.
 */
export async function linkChatToIntake(
    db: Db,
    chatId: string,
    requestId: string,
): Promise<
    | { ok: true }
    | { ok: false; status: number; detail: string }
    | { ok: false; internal: true; error: unknown }
> {
    const { data, error } = await db
        .from("chats")
        .update({ intake_request_id: requestId })
        .eq("id", chatId)
        .is("intake_request_id", null)
        .select("id");
    if (error) return { ok: false, internal: true, error };
    if ((data ?? []).length > 0) return { ok: true };
    const { data: chat, error: readError } = await db
        .from("chats")
        .select("intake_request_id")
        .eq("id", chatId)
        .maybeSingle();
    if (readError) return { ok: false, internal: true, error: readError };
    if (chat?.intake_request_id === requestId) return { ok: true };
    return {
        ok: false,
        status: 409,
        detail: "This chat was just linked to another request. Start a new chat to process this one.",
    };
}
