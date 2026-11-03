import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ALLOWED_DOCUMENT_TYPES,
  contentTypeForDocumentType,
  documentSuffix,
} from "../../lib/documentTypes";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { deleteFileBestEffort, uploadFile } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import {
  emailTokenHash,
  slackSigningSecret,
  type AutomationRow,
} from "./intake.automation";
import { dispatchIntakeInbound } from "./intake.automationJob";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_CHARS,
  cleanText,
  clip,
  type EmailInboundPayload,
  type SkippedAttachment,
  type SlackInboundPayload,
} from "./intake.inboundPayload";
import { verifySlackSignature } from "./intake.slack";

/**
 * The two ways a message reaches automated intake: a Slack event and a
 * Postmark inbound email. Each is checked, stored once in intake_inbound and
 * handed to the intake.inbound job, quickly enough for Slack's three-second
 * deadline. A delivery repeated by the sender finds its row and adds nothing.
 */

const NOT_FOUND = failure("not_found", "Not found.");
/**
 * An email webhook URL that is unknown, replaced or switched off. Postmark
 * stops retrying a delivery only on 403; on 404 it would keep retrying.
 */
const EMAIL_REFUSED = failure("forbidden", "Email intake is not available here.");

export type InboundReceipt = { status: "received" | "duplicate" | "ignored" };

type InboundInsert = {
  id?: string;
  org_id: string;
  source: "email" | "slack";
  external_id: string;
  status: "pending" | "ignored";
  payload: Record<string, unknown> | null;
  error?: string | null;
};

/** Store a message once: the new row's id, or null if it was stored before. */
async function insertInbound(
  db: Db,
  row: InboundInsert,
): Promise<ServiceResult<string | null>> {
  const { data, error } = await db
    .from("intake_inbound")
    .insert({ ...row, error: row.error ?? null })
    .select("id")
    .single();
  if (error && (error as { code?: string }).code === "23505") return ok(null);
  if (error || !data) return internalFailure(error);
  return ok((data as { id: string }).id);
}

/**
 * Hand a stored message to its job. If that fails the sender is answered
 * with an error, so it delivers the message again and that delivery queues it.
 */
async function queue(
  db: Db,
  orgId: string,
  inboundId: string,
): Promise<ServiceResult<null>> {
  try {
    await dispatchIntakeInbound(db, orgId, inboundId);
    return ok(null);
  } catch (cause) {
    return internalFailure(cause);
  }
}

/**
 * The same message delivered again. Nothing is stored twice; a message still
 * waiting is queued again (deduplicated while its job is live), in case the
 * first delivery stored it but could not queue it.
 */
async function redelivered(
  db: Db,
  orgId: string,
  source: "email" | "slack",
  externalId: string,
): Promise<ServiceResult<InboundReceipt>> {
  const existing = await findInbound(db, orgId, source, externalId);
  if (!existing.ok) return existing;
  if (existing.data?.status === "pending") {
    const queued = await queue(db, orgId, existing.data.id);
    if (!queued.ok) return queued;
  }
  return ok({ status: "duplicate" });
}

async function findInbound(
  db: Db,
  orgId: string,
  source: "email" | "slack",
  externalId: string,
): Promise<ServiceResult<{ id: string; status: string } | null>> {
  const { data, error } = await db
    .from("intake_inbound")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("source", source)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) return internalFailure(error);
  return ok((data as { id: string; status: string } | null) ?? null);
}

const slackEnvelope = z.object({
  type: z.string(),
  challenge: z.string().max(500).optional(),
  event: z.unknown().optional(),
});
const SLACK_ID = /^[A-Z0-9]{1,40}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,8}$/;
const appMention = z.object({
  type: z.literal("app_mention"),
  user: z.string().regex(SLACK_ID).optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  ts: z.string().regex(SLACK_TS),
  thread_ts: z.string().regex(SLACK_TS).optional(),
  channel: z.string().regex(SLACK_ID),
  files: z.array(z.unknown()).optional(),
});

function slackFiles(files: unknown[] | undefined): SlackInboundPayload["files"] {
  return (files ?? []).slice(0, 50).flatMap((value) => {
    const file = (value ?? {}) as Record<string, unknown>;
    // Files Slack hosts; an external link or a deleted file has no bytes.
    if (file.mode === "tombstone" || file.mode === "external" || file.is_external === true)
      return [];
    const name =
      typeof file.name === "string" && file.name.trim()
        ? file.name
        : typeof file.title === "string"
          ? file.title
          : "";
    return [
      {
        id: typeof file.id === "string" ? file.id.slice(0, 40) : null,
        name: cleanText(name).slice(0, 255) || "Slack file",
        size: typeof file.size === "number" && file.size >= 0 ? file.size : null,
        url:
          typeof file.url_private_download === "string"
            ? file.url_private_download.slice(0, 2000)
            : null,
      },
    ];
  });
}

/**
 * A request from the organization's Slack app. Signed requests only: a URL
 * verification challenge is answered as soon as a signing secret is saved,
 * so the URL can be verified before Slack is turned on; mentions of MikeGC
 * are stored and queued while Slack is on. Everything else is acknowledged
 * and dropped, so Slack does not retry it.
 */
export async function receiveSlackEvent(
  db: Db,
  webhookId: string,
  rawBody: Buffer,
  headers: { timestamp: string | undefined; signature: string | undefined },
): Promise<ServiceResult<{ challenge?: string }>> {
  const { data, error } = await db
    .from("intake_automation")
    .select(
      "org_id, slack_enabled, slack_bot_user_id, slack_signing_secret_encrypted, slack_signing_secret_iv, slack_signing_secret_tag",
    )
    .eq("slack_webhook_id", webhookId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const settings = data as AutomationRow | null;
  if (!settings) return NOT_FOUND;
  const secret = slackSigningSecret(settings);
  if (!secret) return NOT_FOUND;
  if (!verifySlackSignature({ secret, rawBody, ...headers }))
    return failure("forbidden", "Invalid request signature.");

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return failure("validation", "Invalid event.");
  }
  const envelope = slackEnvelope.safeParse(body);
  if (!envelope.success) return failure("validation", "Invalid event.");
  if (envelope.data.type === "url_verification")
    return envelope.data.challenge
      ? ok({ challenge: envelope.data.challenge })
      : failure("validation", "Invalid event.");
  if (envelope.data.type !== "event_callback" || !settings.slack_enabled)
    return ok({});
  const event = appMention.safeParse(envelope.data.event);
  if (!event.success) return ok({});
  const mention = event.data;
  // Bots, including MikeGC's own replies, never file requests.
  if (
    mention.bot_id ||
    mention.subtype === "bot_message" ||
    !mention.user ||
    mention.user === settings.slack_bot_user_id
  )
    return ok({});
  const payload: SlackInboundPayload = {
    kind: "slack",
    channel: mention.channel,
    ts: mention.ts,
    thread_ts:
      mention.thread_ts && mention.thread_ts !== mention.ts
        ? mention.thread_ts
        : null,
    user: mention.user,
    text: clip(cleanText(mention.text ?? ""), MAX_MESSAGE_CHARS),
    files: slackFiles(mention.files),
  };
  const externalId = `${mention.channel}:${mention.ts}`;
  const stored = await insertInbound(db, {
    org_id: settings.org_id,
    source: "slack",
    external_id: externalId,
    status: "pending",
    payload,
  });
  if (!stored.ok) return stored;
  const queued =
    stored.data === null
      ? await redelivered(db, settings.org_id, "slack", externalId)
      : await queue(db, settings.org_id, stored.data);
  return queued.ok ? ok({}) : queued;
}

/** A token as generate-email-webhook makes it: 32 bytes, base64url. */
const EMAIL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const maybe = <T extends z.ZodTypeAny>(schema: T) =>
  schema.optional().catch(undefined);
/** Postmark's inbound JSON, read leniently: an odd field is dropped, not fatal. */
const postmarkInbound = z.object({
  From: maybe(z.string()),
  FromName: maybe(z.string()),
  FromFull: maybe(
    z.object({ Email: maybe(z.string()), Name: maybe(z.string()) }),
  ),
  Subject: maybe(z.string()),
  MessageID: maybe(z.string()),
  Date: maybe(z.string()),
  TextBody: maybe(z.string()),
  HtmlBody: maybe(z.string()),
  Headers: maybe(
    z.array(z.object({ Name: z.string(), Value: z.string() })).max(1000),
  ),
  Attachments: maybe(
    z.array(
      z.object({
        Name: maybe(z.string()),
        Content: maybe(z.string()),
        ContentType: maybe(z.string()),
        ContentLength: maybe(z.number()),
        ContentID: maybe(z.string()),
      }),
    ),
  ),
});
type PostmarkInbound = z.infer<typeof postmarkInbound>;

function headerOf(mail: PostmarkInbound, name: string): string | null {
  const found = mail.Headers?.find(
    (h) => h.Name.toLowerCase() === name.toLowerCase(),
  );
  return found ? found.Value.trim() : null;
}

/** Out-of-office answers, other automatic replies and bulk or list mail. */
export function isAutomaticEmail(mail: PostmarkInbound): boolean {
  const autoSubmitted = headerOf(mail, "Auto-Submitted")?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headerOf(mail, "X-Autoreply") !== null) return true;
  if (headerOf(mail, "X-Autorespond") !== null) return true;
  const precedence = headerOf(mail, "Precedence")?.toLowerCase();
  return ["bulk", "auto_reply", "list", "junk"].includes(precedence ?? "");
}

/** The message's identity: its Message-ID header, else Postmark's ID. */
function emailExternalId(mail: PostmarkInbound): string | null {
  const id = headerOf(mail, "Message-ID") || mail.MessageID?.trim() || null;
  if (!id) return null;
  return id.length <= 300
    ? id
    : `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

function sender(mail: PostmarkInbound): EmailInboundPayload["from"] {
  const fromHeader = mail.From?.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? mail.From;
  const email = (mail.FromFull?.Email || fromHeader || "").trim().toLowerCase();
  const name = (mail.FromFull?.Name || mail.FromName || "").trim();
  return {
    email: /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 320 ? email : null,
    name: name ? cleanText(name).slice(0, 200) : null,
  };
}

/**
 * Whether the sender's domain, or a parent domain, is on the list. An empty
 * list accepts no one: mail is recorded only from domains an admin named.
 */
export function senderDomainAllowed(
  email: string | null,
  allowed: string[],
): boolean {
  const domain = email?.split("@").pop()?.toLowerCase();
  if (!domain) return false;
  return allowed.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Readable text from an HTML-only email. */
export function htmlToText(html: string): string {
  // Markup is removed until none is left, as removing one tag can join the
  // pieces of another, such as "<scr<b>ipt>".
  let text = html;
  for (let previous = ""; text !== previous; ) {
    previous = text;
    text = text
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "");
  }
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fileName(value: string | undefined, index: number): string {
  const base = (value ?? "").split(/[\\/]/).pop() ?? "";
  const clean = cleanText(base)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(-255);
  return clean || `attachment-${index + 1}`;
}

/**
 * Stage the attachments MikeGC will add: PDF, Word, Excel and PowerPoint,
 * up to 10 of 25 MB each. They wait in storage under the message's row until
 * it is handled, since the job runs later. The rest are listed as skipped,
 * except images embedded in the email's body, such as signature logos.
 */
async function stageAttachments(
  orgId: string,
  inboundId: string,
  attachments: NonNullable<PostmarkInbound["Attachments"]>,
): Promise<Pick<EmailInboundPayload, "attachments" | "skipped">> {
  const accepted: EmailInboundPayload["attachments"] = [];
  const skipped: SkippedAttachment[] = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      const name = fileName(attachment.Name, index);
      const fileType = documentSuffix(name);
      if (!ALLOWED_DOCUMENT_TYPES.has(fileType)) {
        const inline =
          !!attachment.ContentID &&
          (attachment.ContentType ?? "").toLowerCase().startsWith("image/");
        if (!inline) skipped.push({ name, reason: "type" });
        continue;
      }
      const content = attachment.Content ?? "";
      // Base64 is 4 characters per 3 bytes: refuse before decoding.
      if (Math.floor((content.length * 3) / 4) > MAX_ATTACHMENT_BYTES + 3) {
        skipped.push({ name, reason: "size" });
        continue;
      }
      const bytes = Buffer.from(content, "base64");
      if (bytes.length === 0) {
        skipped.push({ name, reason: "unreadable" });
        continue;
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        skipped.push({ name, reason: "size" });
        continue;
      }
      if (accepted.length >= MAX_ATTACHMENTS) {
        skipped.push({ name, reason: "count" });
        continue;
      }
      const key = `intake-inbound/${orgId}/${inboundId}/${accepted.length}`;
      await uploadFile(
        key,
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        contentTypeForDocumentType(fileType),
      );
      accepted.push({ name, file_type: fileType, size: bytes.length, key });
    }
  } catch (error) {
    await discardStaged(accepted.map((a) => a.key));
    throw error;
  }
  return { attachments: accepted, skipped };
}

async function discardStaged(keys: string[]) {
  await Promise.all(
    keys.map((key) => deleteFileBestEffort(key, "intake-inbound-discard")),
  );
}

const AUTOMATIC_EMAIL = "An automatic reply or bulk email, so no request was recorded.";

/**
 * An email Postmark received at the organization's intake address. The URL's
 * token names the organization; an unknown token, or email turned off,
 * answers not found. Automatic mail and senders outside the accepted domains
 * are recorded as ignored, without content, so admins can see them.
 */
export async function receiveInboundEmail(
  db: Db,
  token: string,
  body: unknown,
): Promise<ServiceResult<InboundReceipt>> {
  if (!EMAIL_TOKEN.test(token)) return EMAIL_REFUSED;
  const { data, error } = await db
    .from("intake_automation")
    .select("org_id, email_enabled, email_allowed_domains")
    .eq("email_token_hash", emailTokenHash(token))
    .maybeSingle();
  if (error) return internalFailure(error);
  const settings = data as Pick<
    AutomationRow,
    "org_id" | "email_enabled" | "email_allowed_domains"
  > | null;
  if (!settings?.email_enabled) return EMAIL_REFUSED;
  const parsed = postmarkInbound.safeParse(body);
  if (!parsed.success || !body || typeof body !== "object")
    return failure("validation", "Not a Postmark inbound message.");
  const mail = parsed.data;
  const externalId = emailExternalId(mail);
  if (!externalId) return failure("validation", "Not a Postmark inbound message.");
  const orgId = settings.org_id;

  // A repeated delivery: nothing to stage again.
  const existing = await findInbound(db, orgId, "email", externalId);
  if (!existing.ok) return existing;
  if (existing.data) return redelivered(db, orgId, "email", externalId);

  const from = sender(mail);
  const ignored = async (
    reason: string,
  ): Promise<ServiceResult<InboundReceipt>> => {
    const stored = await insertInbound(db, {
      org_id: orgId,
      source: "email",
      external_id: externalId,
      status: "ignored",
      payload: null,
      error: clip(reason, 200),
    });
    if (!stored.ok) return stored;
    return ok({ status: stored.data === null ? "duplicate" : "ignored" });
  };
  if (isAutomaticEmail(mail)) return ignored(AUTOMATIC_EMAIL);
  const allowed = settings.email_allowed_domains ?? [];
  if (allowed.length === 0)
    return ignored(
      "No sender domains are accepted yet. Add one in Intake settings.",
    );
  if (!senderDomainAllowed(from.email, allowed)) {
    const domain = from.email?.split("@").pop()?.slice(0, 60);
    return ignored(
      domain
        ? `The sender's domain, ${domain}, isn't one of the accepted domains.`
        : "The sender's address couldn't be read, and only accepted domains are recorded.",
    );
  }

  const inboundId = randomUUID();
  let staged: Pick<EmailInboundPayload, "attachments" | "skipped">;
  try {
    staged = await stageAttachments(orgId, inboundId, mail.Attachments ?? []);
  } catch (cause) {
    return internalFailure(cause);
  }
  const text = mail.TextBody?.trim()
    ? mail.TextBody
    : mail.HtmlBody
      ? htmlToText(mail.HtmlBody)
      : "";
  const sent = mail.Date ? new Date(mail.Date) : new Date();
  const payload: EmailInboundPayload = {
    kind: "email",
    from,
    subject: mail.Subject?.trim() ? cleanText(mail.Subject.trim()).slice(0, 1000) : null,
    date: (Number.isNaN(sent.getTime()) ? new Date() : sent).toISOString(),
    text: clip(cleanText(text), MAX_MESSAGE_CHARS),
    ...staged,
  };
  const stored = await insertInbound(db, {
    id: inboundId,
    org_id: orgId,
    source: "email",
    external_id: externalId,
    status: "pending",
    payload,
  });
  // Not stored, or another delivery of the same message stored it first:
  // nothing will read these copies.
  if (!stored.ok || stored.data === null)
    await discardStaged(staged.attachments.map((a) => a.key));
  if (!stored.ok) return stored;
  if (stored.data === null) return redelivered(db, orgId, "email", externalId);
  const queued = await queue(db, orgId, stored.data);
  return queued.ok ? ok({ status: "received" }) : queued;
}
