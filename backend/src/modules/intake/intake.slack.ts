import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A small client for the organization's own Slack app: the Web API methods
 * automated intake uses, request signing, and Slack's message markup. Every
 * call has a deadline, and failures carry only Slack's error code, never a
 * response body or the token.
 */

const SLACK_API = "https://slack.com/api/";
const API_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 60_000;
/** Slack's replay window for signed requests. */
const SIGNATURE_WINDOW_SECONDS = 5 * 60;

/** A Slack Web API failure. `code` is Slack's error string, safe to log. */
export class SlackApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Slack API error (${code})`);
    this.name = "SlackApiError";
    this.code = code;
  }
}

/** Failures that retrying cannot fix: the app's setup has to change. */
const PERMANENT = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "missing_scope",
  "no_permission",
  "not_in_channel",
  "channel_not_found",
  "thread_not_found",
  "message_not_found",
  "is_archived",
  "invalid_file_url",
  "file_not_authorized",
]);
export function isPermanentSlackError(error: unknown): boolean {
  return error instanceof SlackApiError && PERMANENT.has(error.code);
}
/** Codes meaning the bot token itself was refused. */
export const SLACK_TOKEN_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
]);

const safeCode = (value: unknown) =>
  typeof value === "string" && /^[a-z0-9_]{1,60}$/.test(value)
    ? value
    : "unknown_error";

/**
 * Whether a request came from the Slack app holding `secret`: `v0=` and the
 * HMAC-SHA256 of `v0:<timestamp>:<raw body>`, sent within five minutes.
 */
export function verifySlackSignature(args: {
  secret: string;
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): boolean {
  const { timestamp, signature } = args;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return false;
  if (!signature || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const expected =
    "v0=" +
    createHmac("sha256", args.secret)
      .update(`v0:${timestamp}:`)
      .update(args.rawBody)
      .digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Form-encoded, which every Web API method accepts, unlike JSON bodies. */
async function slackApi<T>(
  method: string,
  token: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) body.set(key, value);
  let response: Response;
  try {
    response = await fetch(SLACK_API + method, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new SlackApiError("network_error");
  }
  if (response.status === 429) throw new SlackApiError("ratelimited");
  if (!response.ok) throw new SlackApiError(`http_${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SlackApiError("invalid_response");
  }
  const data = json as { ok?: unknown; error?: unknown } | null;
  if (data?.ok !== true) throw new SlackApiError(safeCode(data?.error));
  return json as T;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** The workspace and bot a token belongs to. */
export async function slackAuthTest(token: string) {
  const data = await slackApi<Record<string, unknown>>("auth.test", token);
  const teamId = text(data.team_id, 40);
  const userId = text(data.user_id, 40);
  if (!teamId || !userId) throw new SlackApiError("invalid_response");
  return { team_id: teamId, team: text(data.team, 200), user_id: userId };
}

export type SlackPerson = { name: string | null; email: string | null };

/** A person's name and, with users:read.email, address; null if unknown. */
export async function slackUserInfo(
  token: string,
  userId: string,
): Promise<SlackPerson | null> {
  try {
    const data = await slackApi<{ user?: Record<string, unknown> }>(
      "users.info",
      token,
      { user: userId },
    );
    const user = data.user ?? {};
    const profile = (user.profile ?? {}) as Record<string, unknown>;
    return {
      name:
        text(profile.real_name, 200) ??
        text(user.real_name, 200) ??
        text(profile.display_name, 200) ??
        text(user.name, 200),
      email: text(profile.email, 320),
    };
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "user_not_found")
      return null;
    throw error;
  }
}

export type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  size?: number;
  mode?: string;
  is_external?: boolean;
  url_private_download?: string;
};
export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: SlackFile[];
};

/** Order Slack timestamps ("1700000000.000100") without float rounding. */
export function compareSlackTs(a: string, b: string): number {
  const [aSec = "0", aFrac = ""] = a.split(".");
  const [bSec = "0", bFrac = ""] = b.split(".");
  const seconds = Number(aSec) - Number(bSec);
  if (seconds !== 0) return Math.sign(seconds);
  return Math.sign(Number(aFrac.padEnd(6, "0")) - Number(bFrac.padEnd(6, "0")));
}

/** A thread's messages, oldest first, up to and including `latest`. */
export async function slackThreadMessages(
  token: string,
  channel: string,
  threadTs: string,
  latest: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  // Five pages of 200 is far more than a request thread needs.
  for (let page = 0; page < 5; page++) {
    const data = await slackApi<{
      messages?: SlackMessage[];
      response_metadata?: { next_cursor?: string };
    }>("conversations.replies", token, {
      channel,
      ts: threadTs,
      latest,
      inclusive: "true",
      limit: "200",
      cursor,
    });
    messages.push(
      ...(data.messages ?? []).filter(
        (m) => typeof m?.ts === "string" && compareSlackTs(m.ts, latest) <= 0,
      ),
    );
    cursor = data.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return messages.sort((a, b) => compareSlackTs(a.ts, b.ts));
}

/** Post in a thread. Links are not unfurled, so the reply stays one line. */
export async function slackPostMessage(
  token: string,
  args: { channel: string; threadTs: string; text: string },
): Promise<void> {
  await slackApi("chat.postMessage", token, {
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text,
    unfurl_links: "false",
    unfurl_media: "false",
  });
}

/**
 * Download a file shared in Slack with the bot token. Only Slack's file host
 * is ever sent the token, and the body is read no further than `maxBytes`:
 * a larger file returns null.
 */
export async function downloadSlackFile(
  token: string,
  url: string,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new SlackApiError("invalid_file_url");
  }
  if (target.protocol !== "https:" || target.hostname !== "files.slack.com")
    throw new SlackApiError("invalid_file_url");
  let response: Response;
  try {
    // A cross-origin redirect drops the Authorization header (Fetch spec).
    response = await fetch(target, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
  } catch {
    throw new SlackApiError("network_error");
  }
  if (response.status === 429) throw new SlackApiError("ratelimited");
  if (!response.ok) throw new SlackApiError(`http_${response.status}`);
  // Slack answers an unauthorized file request with its sign-in page.
  if ((response.headers.get("content-type") ?? "").includes("text/html")) {
    await response.body?.cancel().catch(() => undefined);
    throw new SlackApiError("file_not_authorized");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

const MENTION = /<@([UW][A-Z0-9]{1,30})(?:\|[^>]*)?>/g;

/** The people a message mentions, by Slack user ID. */
export function mentionedUsers(value: string): string[] {
  return [...value.matchAll(MENTION)].map((match) => match[1]!);
}

/**
 * Slack's markup as plain text: `<@U1>` becomes the person's name,
 * `<url|label>` becomes "label (url)", and the escaped `&`, `<` and `>` are
 * restored. Mentions of MikeGC itself are dropped.
 */
export function slackTextToPlain(
  value: string,
  names: ReadonlyMap<string, string>,
  botUserId: string | null,
): string {
  return value
    .replace(/<([^<>]*)>/g, (_match, inner: string) => {
      const bar = inner.indexOf("|");
      const target = bar >= 0 ? inner.slice(0, bar) : inner;
      const label = bar >= 0 ? inner.slice(bar + 1) : "";
      if (target.startsWith("@")) {
        const id = target.slice(1);
        if (id === botUserId) return "";
        return `@${names.get(id) ?? (label || "someone")}`;
      }
      if (target.startsWith("#")) return `#${label || "channel"}`;
      if (target.startsWith("!")) {
        // <!here>, <!subteam^S1|@legal>, <!date^…|fallback text>
        if (label) return label;
        return `@${target.slice(1).split("^")[0]}`;
      }
      const address = target.startsWith("mailto:") ? target.slice(7) : null;
      if (!label || label === target || label === address)
        return address ?? target;
      return `${label} (${target})`;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

/** Text placed inside a Slack message, with its control characters escaped. */
export function slackEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
