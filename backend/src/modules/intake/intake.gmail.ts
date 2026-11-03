import MailComposer from "nodemailer/lib/mail-composer";
import type { JWT } from "google-auth-library";
import { ChannelDeliveryError, type ChannelAdapter } from "./intake.channels";
import { MAX_ATTACHMENT_BYTES } from "./intake.inboundPayload";
import {
  fitAttachments,
  headerValue,
  htmlToText,
  mailAddress,
  normalizeMessageId,
  parseMailbox,
  addressList,
  recordEmailMessageIds,
  replySubject,
  type MailAttachmentSource,
  type MailHeader,
} from "./intake.mail";
import { encodedSize, mailBody, type ReadMail } from "./intake.outlook";

/**
 * Gmail through the Gmail API: the organization's intake mailbox, a
 * Workspace user account, read and replied from with the deployment's
 * service account by domain-wide delegation (scope gmail.modify). Replies
 * are built as MIME with nodemailer's MailComposer, which only builds the
 * message; the Gmail API sends it in its thread.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const API_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 120_000;
const LABEL = "MikeGC";

/** A failed Gmail call. `sentence` is what members or admins see. */
export class GmailApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly permanent: boolean;
  readonly sentence: string;
  constructor(status: number, code: string, permanent: boolean, sentence: string) {
    super(`Gmail API error (${status} ${code})`);
    this.name = "GmailApiError";
    this.status = status;
    this.code = code;
    this.permanent = permanent;
    this.sentence = sentence.slice(0, 200);
  }
}

const DELEGATION_REFUSED =
  "Google refused MikeGC access to the intake mailbox. Check the service account's domain-wide delegation for the gmail.modify scope.";

type ServiceAccount = { client_email: string; private_key: string; client_id: string | null };

/** The deployment's service account, from INTAKE_GMAIL_SERVICE_ACCOUNT_KEY. */
export function gmailServiceAccount(): ServiceAccount | null {
  const raw = process.env.INTAKE_GMAIL_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) return null;
  try {
    const key = JSON.parse(raw) as Record<string, unknown>;
    if (typeof key.client_email !== "string" || typeof key.private_key !== "string") return null;
    return {
      client_email: key.client_email,
      private_key: key.private_key,
      client_id: typeof key.client_id === "string" ? key.client_id : null,
    };
  } catch {
    return null;
  }
}

const clients = new Map<string, JWT>();

/** An access token for the mailbox, impersonated by domain-wide delegation. */
async function gmailToken(mailbox: string): Promise<string> {
  const account = gmailServiceAccount();
  if (!account)
    throw new GmailApiError(
      0,
      "not_configured",
      true,
      "This deployment has no Gmail service account. Set INTAKE_GMAIL_SERVICE_ACCOUNT_KEY.",
    );
  const key = mailbox.toLowerCase();
  let client = clients.get(key);
  if (!client) {
    const { JWT } = await import("google-auth-library");
    client = new JWT({
      email: account.client_email,
      key: account.private_key,
      scopes: [GMAIL_SCOPE],
      subject: mailbox,
    });
    if (clients.size >= 200) {
      const oldest = clients.keys().next().value;
      if (oldest !== undefined) clients.delete(oldest);
    }
    clients.set(key, client);
  }
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("no token");
    return token;
  } catch {
    clients.delete(key);
    throw new GmailApiError(401, "unauthorized_client", true, DELEGATION_REFUSED);
  }
}

async function gmailFetch<T>(
  mailbox: string,
  path: string,
  init: { method?: string; json?: unknown; long?: boolean } = {},
): Promise<T> {
  const token = await gmailToken(mailbox);
  let response: Response;
  try {
    response = await fetch(`${GMAIL_API}${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(init.long ? SEND_TIMEOUT_MS : API_TIMEOUT_MS),
    });
  } catch {
    throw new GmailApiError(0, "network_error", false, "MikeGC couldn't reach Gmail.");
  }
  if (response.ok) {
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }
  let reason = `http_${response.status}`;
  try {
    const json = (await response.json()) as { error?: { status?: unknown; errors?: { reason?: unknown }[] } };
    const r = json.error?.errors?.[0]?.reason ?? json.error?.status;
    if (typeof r === "string" && /^[A-Za-z_]{1,60}$/.test(r)) reason = r;
  } catch {
    // The status says enough.
  }
  const status = response.status;
  if (status === 429 || status >= 500)
    throw new GmailApiError(status, reason, false, "Gmail is busy. MikeGC will try again.");
  if (status === 401 || status === 403)
    throw new GmailApiError(status, reason, true, DELEGATION_REFUSED);
  if (status === 404)
    throw new GmailApiError(status, reason, true, "Gmail couldn't find what MikeGC asked for.");
  throw new GmailApiError(status, reason, true, "Gmail wouldn't accept this request.");
}

/** The mailbox's address and current history ID: checks MikeGC can open it. */
export async function gmailProfile(mailbox: string): Promise<{ emailAddress: string; historyId: string }> {
  const profile = await gmailFetch<{ emailAddress?: string; historyId?: string }>(mailbox, "/profile");
  if (!profile?.emailAddress || !profile.historyId)
    throw new GmailApiError(0, "invalid_response", false, "Gmail sent an answer MikeGC couldn't read.");
  return { emailAddress: profile.emailAddress, historyId: String(profile.historyId) };
}

/**
 * Messages added to the Inbox since `startHistoryId`, and the history ID to
 * read on from; "expired" when Gmail no longer keeps that history.
 */
export async function gmailHistory(
  mailbox: string,
  startHistoryId: string,
): Promise<{ ids: string[]; historyId: string } | "expired"> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let historyId = startHistoryId;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
      labelId: "INBOX",
      maxResults: "500",
      ...(pageToken ? { pageToken } : {}),
    });
    let data: {
      history?: { messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[] }[];
      historyId?: string;
      nextPageToken?: string;
    };
    try {
      data = await gmailFetch(mailbox, `/history?${query}`);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return "expired";
      throw error;
    }
    for (const h of data.history ?? [])
      for (const added of h.messagesAdded ?? [])
        if (added.message?.id && (added.message.labelIds ?? ["INBOX"]).includes("INBOX"))
          ids.push(added.message.id);
    if (data.historyId) historyId = String(data.historyId);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return { ids: [...new Set(ids)], historyId };
}

/** Inbox messages received after a time, when the history is too old to list. */
export async function gmailListSince(mailbox: string, after: Date): Promise<string[]> {
  const q = `in:inbox after:${Math.floor(after.getTime() / 1000)}`;
  const data = await gmailFetch<{ messages?: { id: string }[] }>(
    mailbox,
    `/messages?${new URLSearchParams({ q, maxResults: "200" })}`,
  );
  return (data?.messages ?? []).map((m) => m.id);
}

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
};

const decode = (data: string | undefined) =>
  data ? Buffer.from(data, "base64url").toString("utf8") : "";

/** One received email with what recording it needs. */
export async function gmailReadMessage(mailbox: string, id: string): Promise<ReadMail | null> {
  let message: {
    id: string;
    threadId?: string;
    labelIds?: string[];
    internalDate?: string;
    payload?: GmailPart;
  };
  try {
    message = await gmailFetch(mailbox, `/messages/${encodeURIComponent(id)}?format=full`);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return null;
    throw error;
  }
  const headers: MailHeader[] = (message.payload?.headers ?? []).map((h) => ({ name: h.name, value: h.value }));
  const body: { plain: string | null; html: string | null } = { plain: null, html: null };
  const attachments: MailAttachmentSource[] = [];
  const walk = (part: GmailPart, depth: number) => {
    if (depth > 10) return;
    const partHeaders = part.headers ?? [];
    const disposition = (partHeaders.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "").toLowerCase();
    const contentId = partHeaders.some((h) => h.name.toLowerCase() === "content-id");
    const isFile = !!part.filename || disposition.startsWith("attachment");
    if (isFile && (part.body?.attachmentId || part.body?.data)) {
      const file = part.body;
      attachments.push({
        name: part.filename ?? null,
        contentType: part.mimeType ?? null,
        size: typeof file.size === "number" ? file.size : null,
        inline: disposition.startsWith("inline") || contentId,
        read: async () => {
          if (file.data) return Buffer.from(file.data, "base64url");
          const data = await gmailFetch<{ data?: string; size?: number }>(
            mailbox,
            `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file.attachmentId!)}`,
            { long: true },
          );
          if (!data?.data) return null;
          const bytes = Buffer.from(data.data, "base64url");
          return bytes.length > MAX_ATTACHMENT_BYTES ? null : bytes;
        },
      });
      return;
    }
    if (part.mimeType === "text/plain" && body.plain === null) body.plain = decode(part.body?.data);
    else if (part.mimeType === "text/html" && body.html === null) body.html = decode(part.body?.data);
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  if (message.payload) walk(message.payload, 0);
  const text = body.plain?.trim() ? body.plain : body.html ? htmlToText(body.html) : "";
  const date = headerValue(headers, "Date");
  const sent = date ? new Date(date) : new Date(Number(message.internalDate ?? Date.now()));
  return {
    provider: "gmail",
    providerId: message.id,
    internetMessageId: headerValue(headers, "Message-ID"),
    thread: message.threadId ?? message.id,
    headers,
    from: parseMailbox(headerValue(headers, "From")),
    to: addressList(headerValue(headers, "To")),
    cc: addressList(headerValue(headers, "Cc")),
    subject: headerValue(headers, "Subject"),
    date: (Number.isNaN(sent.getTime()) ? new Date() : sent).toISOString(),
    text,
    newText: text,
    attachments,
    isDraft: (message.labelIds ?? []).includes("DRAFT"),
  };
}

const labelIds = new Map<string, string>();

/** Mark a recorded email with the "MikeGC" label, made on first use. */
export async function gmailMarkRecorded(mailbox: string, id: string) {
  try {
    let label = labelIds.get(mailbox.toLowerCase());
    if (!label) {
      const list = await gmailFetch<{ labels?: { id: string; name: string }[] }>(mailbox, "/labels");
      label =
        list?.labels?.find((l) => l.name === LABEL)?.id ??
        (await gmailFetch<{ id: string }>(mailbox, "/labels", {
          json: { name: LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" },
        })).id;
      labelIds.set(mailbox.toLowerCase(), label);
    }
    await gmailFetch(mailbox, `/messages/${encodeURIComponent(id)}/modify`, {
      json: { addLabelIds: [label] },
    });
  } catch {
    // A missing label never stops recording.
  }
}

/** An RFC 5322 message, as Gmail's send takes it. */
export async function buildMime(args: {
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  autoSubmitted: boolean;
  outboundId: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType?: string }[];
}): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: args.from.name, address: args.from.address },
    to: args.to,
    cc: args.cc.length ? args.cc : undefined,
    subject: args.subject,
    messageId: `<${args.messageId}>`,
    inReplyTo: args.inReplyTo ? `<${args.inReplyTo}>` : undefined,
    references: args.references.length ? args.references.map((r) => `<${r}>`).join(" ") : undefined,
    headers: {
      "X-MikeGC-Outbound": args.outboundId,
      ...(args.autoSubmitted ? { "Auto-Submitted": "auto-generated" } : {}),
    },
    text: args.text,
    attachments: args.attachments,
  });
  return new Promise((resolve, reject) =>
    composer.compile().build((error: Error | null, message: Buffer) =>
      error ? reject(error) : resolve(message),
    ),
  );
}

/** The ID of a sent message carrying our Message-ID, or null. */
async function findSent(mailbox: string, messageId: string, outboundId: string, thread: string) {
  const found = await gmailFetch<{ messages?: { id: string }[] }>(
    mailbox,
    `/messages?${new URLSearchParams({ q: `rfc822msgid:${messageId}`, maxResults: "1" })}`,
  );
  if (found?.messages?.[0]) return found.messages[0].id;
  // Gmail may replace the Message-ID: look in the thread for our outbox header.
  const threadData = await gmailFetch<{ messages?: { id: string; payload?: GmailPart }[] }>(
    mailbox,
    `/threads/${encodeURIComponent(thread)}?format=metadata&metadataHeaders=X-MikeGC-Outbound`,
  ).catch(() => null);
  for (const m of threadData?.messages ?? [])
    if ((m.payload?.headers ?? []).some((h) => h.name.toLowerCase() === "x-mikegc-outbound" && h.value.trim() === outboundId))
      return m.id;
  return null;
}

/** The Message-ID Gmail kept for a sent message. */
async function sentMessageId(mailbox: string, id: string): Promise<string | null> {
  const data = await gmailFetch<{ payload?: GmailPart }>(
    mailbox,
    `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID`,
  ).catch(() => null);
  return normalizeMessageId(
    (data?.payload?.headers ?? []).find((h) => h.name.toLowerCase() === "message-id")?.value,
  );
}

/** A test email from the intake mailbox to the admin connecting it. */
export async function gmailSendTest(mailbox: string, to: string, fromName: string) {
  const raw = await buildMime({
    from: { name: fromName, address: mailbox },
    to: [to],
    cc: [],
    subject: "MikeGC is connected to the intake mailbox",
    messageId: `test-${Date.now()}@mikegc`,
    inReplyTo: null,
    references: [],
    autoSubmitted: true,
    outboundId: "test",
    text: "MikeGC can read and send from this intake mailbox. Requests emailed here will be recorded in Intake.",
    attachments: [],
  });
  await gmailFetch(mailbox, "/messages/send", { json: { raw: raw.toString("base64url") }, long: true });
}

function gmailError(error: unknown): Error {
  if (!(error instanceof GmailApiError)) return error as Error;
  if (error.code === "invalidArgument" || error.status === 400)
    return new ChannelDeliveryError("Gmail wouldn't send this email.", true);
  return new ChannelDeliveryError(error.sentence, error.permanent);
}

/** Our Message-ID for an outbox row. */
export const outboundMessageId = (outboundId: string) => `${outboundId}@mikegc`;

/**
 * The Gmail adapter: a reply in the thread, from "Emma Chen via Legal" at
 * the intake address for a member's message or the configured name for
 * MikeGC's, with our own In-Reply-To, References (the 20 newest) and
 * Message-ID, Auto-Submitted on MikeGC's own questions, and the documents
 * that fit within Gmail's 25 MB after encoding.
 */
export const gmailAdapter: ChannelAdapter = {
  source: "gmail",
  async deliver(ctx, link, message, delivered) {
    if (delivered) return { externalId: delivered, documents: message.documents };
    if (!ctx.settings.email_enabled || ctx.settings.email_provider !== "gmail" || !ctx.settings.email_mailbox)
      throw new ChannelDeliveryError("The intake mailbox isn't connected, so MikeGC can't email the requester.", true);
    const mailbox = ctx.settings.email_mailbox;
    try {
      const thread = mailAddress(link);
      const { data: ids, error } = await ctx.db
        .from("intake_email_message_ids")
        .select("message_id, created_at")
        .eq("link_id", link.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      const references = ((ids ?? []) as { message_id: string }[])
        .map((r) => r.message_id)
        .filter((id) => !id.startsWith("sha256:"))
        .reverse();
      const documents = message.documents.map((d) => ({ ...d }));
      const { attached, tooLarge } = fitAttachments(documents, thread.max_attachment_bytes, encodedSize);
      const files = [];
      for (const doc of attached)
        files.push({ filename: doc.name, content: Buffer.from(await ctx.readDocument(doc)) });
      const raw = await buildMime({
        from: {
          name:
            message.author.kind === "member"
              ? `${message.author.name} via ${ctx.fromName}`.slice(0, 120)
              : ctx.fromName,
          address: mailbox,
        },
        to: thread.to.filter((a) => a.toLowerCase() !== mailbox.toLowerCase()),
        cc: thread.cc.filter((a) => a.toLowerCase() !== mailbox.toLowerCase()),
        subject: replySubject(thread.subject),
        messageId: outboundMessageId(message.id),
        inReplyTo: references[references.length - 1] ?? null,
        references,
        autoSubmitted: message.author.kind === "mikegc",
        outboundId: message.id,
        text: mailBody(message, {
          fromName: ctx.fromName,
          signMember: false,
          tooLarge: tooLarge.map((d) => d.name),
          withheld: [],
        }),
        attachments: files,
      });
      if (raw.length > thread.max_attachment_bytes + 1024 * 1024)
        throw new ChannelDeliveryError("The email was too large for Gmail to send.", true);
      const sent = await gmailFetch<{ id?: string }>(mailbox, "/messages/send", {
        json: { raw: raw.toString("base64url"), threadId: thread.thread },
        long: true,
      });
      for (const doc of attached) doc.externalId = "attached";
      for (const doc of tooLarge) doc.leftOut = true;
      const kept = sent?.id ? await sentMessageId(mailbox, sent.id) : null;
      const messageId = kept ?? outboundMessageId(message.id);
      await recordEmailMessageIds(ctx.db, link.org_id, link.id, [messageId]);
      return { externalId: messageId, documents };
    } catch (error) {
      throw gmailError(error);
    }
  },
  async findDelivered(ctx, link, message) {
    const mailbox = ctx.settings.email_mailbox;
    if (!mailbox) return null;
    try {
      const thread = mailAddress(link);
      const id = await findSent(mailbox, outboundMessageId(message.id), message.id, thread.thread);
      if (!id) return null;
      const messageId = (await sentMessageId(mailbox, id)) ?? outboundMessageId(message.id);
      await recordEmailMessageIds(ctx.db, link.org_id, link.id, [messageId]);
      return messageId;
    } catch (error) {
      throw gmailError(error);
    }
  },
};
