import { z } from "zod";

/**
 * What MikeGC keeps of a received message until it is handled, and the
 * progress a retried job resumes from. The row's payload is cleared once the
 * message is done, failed or ignored; the request then holds its content.
 */

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Longest message text kept; the request's description is shorter still. */
export const MAX_MESSAGE_CHARS = 100_000;

/** Why an attachment was left off the request, listed in its description. */
export const skippedReason = z.enum(["type", "size", "count", "unreadable"]);
export type SkippedReason = z.infer<typeof skippedReason>;
const skipped = z.object({ name: z.string(), reason: skippedReason });
export type SkippedAttachment = z.infer<typeof skipped>;

/** A file Slack shared on the message, read later with the bot token. */
const slackFile = z.object({
  id: z.string().nullable(),
  name: z.string(),
  size: z.number().nullable(),
  url: z.string().nullable(),
});
export type SlackFileRef = z.infer<typeof slackFile>;

/**
 * An accepted attachment: an email's bytes staged in storage under `key`, or
 * a Slack file to download from `url`.
 */
const candidate = z.object({
  name: z.string(),
  file_type: z.string(),
  size: z.number().nullable(),
  key: z.string().nullable(),
  url: z.string().nullable(),
});
export type AttachmentCandidate = z.infer<typeof candidate>;

/**
 * The request triage decided on, saved before it is recorded so a retry
 * records the same request without asking the model again.
 */
export const triagePlan = z.object({
  subject: z.string(),
  description: z.string(),
  requester_name: z.string(),
  requester_email: z.string().nullable(),
  requested_by_date: z.string().nullable(),
  assignee_id: z.string().nullable(),
  /**
   * AI preprocessing, when the rule that assigned the request asks for it,
   * with the workflow or playbook to follow, if any.
   */
  preprocess: z
    .object({
      with: z
        .object({ kind: z.enum(["workflow", "playbook"]), id: z.string() })
        .nullable(),
    })
    .nullable()
    .default(null),
  /** Indexes into `candidates` of the attachments to add. */
  attachments: z.array(z.number().int().nonnegative()),
  candidates: z.array(candidate),
  /** Whether a model shaped the request, or the safe defaults did. */
  triaged: z.boolean(),
});
export type TriagePlan = z.infer<typeof triagePlan>;

/** Each attachment's document, named before it is made so it is made once. */
const documentEntry = z.object({
  document_id: z.string(),
  version_id: z.string(),
  done: z.boolean(),
});
export type DocumentEntry = z.infer<typeof documentEntry>;

const progress = {
  plan: triagePlan.optional(),
  documents: z.record(z.string(), documentEntry).optional(),
  /**
   * Set once the request is recorded. The message's link to it is cleared if
   * the request is deleted, and this tells that apart from never recorded.
   */
  recorded: z.boolean().optional(),
  /** Set once the Slack thread has MikeGC's answer, so it is sent once. */
  replied: z.boolean().optional(),
  /** Set once AI preprocessing is queued, so it is queued once. */
  preprocessQueued: z.boolean().optional(),
};

export const slackInboundPayload = z.object({
  kind: z.literal("slack"),
  channel: z.string(),
  ts: z.string(),
  /** The thread the mention was posted in, when not at the top level. */
  thread_ts: z.string().nullable(),
  user: z.string(),
  text: z.string(),
  files: z.array(slackFile),
  ...progress,
});
export type SlackInboundPayload = z.infer<typeof slackInboundPayload>;

export const emailInboundPayload = z.object({
  kind: z.literal("email"),
  from: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
  subject: z.string().nullable(),
  /** When it was sent, ISO 8601. */
  date: z.string(),
  text: z.string(),
  attachments: z.array(
    z.object({
      name: z.string(),
      file_type: z.string(),
      size: z.number(),
      key: z.string(),
    }),
  ),
  skipped: z.array(skipped),
  ...progress,
});
export type EmailInboundPayload = z.infer<typeof emailInboundPayload>;

export const inboundPayload = z.discriminatedUnion("kind", [
  slackInboundPayload,
  emailInboundPayload,
]);
export type InboundPayload = z.infer<typeof inboundPayload>;

/** Storage keys an email's attachments wait under until it is handled. */
export function stagedKeys(payload: unknown): string[] {
  const parsed = emailInboundPayload.safeParse(payload);
  return parsed.success ? parsed.data.attachments.map((a) => a.key) : [];
}

/** Postgres text cannot hold NUL, and a lone surrogate is not valid UTF-8. */
export function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end);
}
