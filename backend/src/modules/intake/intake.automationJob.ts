import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createDocumentVersion } from "../documents/documents.service";
import { convertedPdfKey } from "../../lib/convert";
import { contentSha256 } from "../../lib/documentVersions";
import {
  ALLOWED_DOCUMENT_TYPES,
  contentTypeForDocumentType,
  documentSuffix,
  shouldConvertToPdf,
} from "../../lib/documentTypes";
import { enqueueDbJob, enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import { NonRetryableJobError, dbJobsEnabled } from "../../lib/dbq/runner";
import type { DbJob } from "../../lib/dbq/types";
import { isPersonalOrg } from "../../lib/personalOrgs";
import { enqueueConversion } from "../../lib/queue/conversionQueue";
import { configuredFrontendUrl } from "../../lib/runtimeConfig";
import { safeError } from "../../lib/safeError";
import {
  deleteFileBestEffort,
  downloadFile,
  storageKey,
  uploadFile,
} from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import {
  loadAutomationRow,
  slackBotToken,
  type AutomationRow,
} from "./intake.automation";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_CHARS,
  cleanText,
  clip,
  inboundPayload,
  stagedKeys,
  type AttachmentCandidate,
  type EmailInboundPayload,
  type InboundPayload,
  type SkippedAttachment,
  type SlackInboundPayload,
  type TriagePlan,
} from "./intake.inboundPayload";
import { intakeRpc } from "./intake.shared";
import { queueIntakePreprocess } from "./intake.preprocess";
import {
  SLACK_TOKEN_ERRORS,
  SlackApiError,
  downloadSlackFile,
  isPermanentSlackError,
  mentionedUsers,
  slackEscape,
  slackPostMessage,
  slackTextToPlain,
  slackThreadMessages,
  slackUserInfo,
  type SlackFile,
  type SlackPerson,
} from "./intake.slack";
import {
  formatSent,
  loadTriageRules,
  resolveIntakeModel,
  triageInbound,
  type InboundMessage,
} from "./intake.triage";

/**
 * The intake.inbound job: triage a received message, record it as MikeGC's
 * request, add its documents and answer in Slack. Every step can run again:
 * the plan, each document's ids and the Slack reply are saved on the message
 * as they happen, and recording the request is keyed by the message.
 */

export const INTAKE_INBOUND_JOB = "intake.inbound";
const JOB_ATTEMPTS = 4;
/** A document owner segment for MikeGC's files, which have no uploader. */
const ownerSegment = (orgId: string) => `intake-${orgId}`;

/**
 * A failure an admin can act on. Its message is the sentence shown in the
 * settings page's recent messages, so it never carries message content.
 */
class IntakeAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeAutomationError";
  }
}

const GENERIC_FAILURE = "MikeGC couldn't record this message. Try sending it again.";
const RECORDED_INCOMPLETE =
  "The request was recorded, but MikeGC couldn't add all of its documents or reply in Slack.";

/** The sentence an admin sees for why a message failed. */
function adminMessage(error: unknown): string {
  if (error instanceof IntakeAutomationError) return error.message;
  if (error instanceof SlackApiError) {
    if (SLACK_TOKEN_ERRORS.has(error.code))
      return "Slack rejected MikeGC's bot token. Save a new one in Intake settings.";
    if (error.code === "missing_scope" || error.code === "no_permission")
      return "The Slack app is missing a permission. Reinstall it from the manifest in the setup guide.";
    if (error.code === "not_in_channel" || error.code === "channel_not_found")
      return "MikeGC can't read that Slack channel. Invite @MikeGC to it.";
    if (error.code === "thread_not_found" || error.code === "message_not_found")
      return "The Slack message was deleted before MikeGC could read it.";
    if (error.code === "file_not_authorized" || error.code === "invalid_file_url")
      return "MikeGC couldn't download a file from Slack. Check that the Slack app has the files:read permission.";
    return "MikeGC couldn't reach Slack.";
  }
  return GENERIC_FAILURE;
}

type InboundRow = {
  id: string;
  org_id: string;
  source: "email" | "slack";
  status: "pending" | "done" | "failed" | "ignored";
  payload: unknown;
  request_id: string | null;
  error: string | null;
};

const jobPayload = z.object({ inboundId: z.uuid(), orgId: z.uuid() });

async function loadInbound(
  db: Db,
  ids: { inboundId: string; orgId: string },
): Promise<InboundRow | null> {
  const { data, error } = await db
    .from("intake_inbound")
    .select("id, org_id, source, status, payload, request_id, error")
    .eq("id", ids.inboundId)
    .eq("org_id", ids.orgId)
    .maybeSingle();
  if (error) throw error;
  return (data as InboundRow | null) ?? null;
}

/** Write progress, only while the message is still waiting. */
async function savePayload(db: Db, id: string, payload: InboundPayload) {
  const { error } = await db
    .from("intake_inbound")
    .update({ payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw error;
}

/**
 * Leave the waiting state for good, dropping the content. An email's staged
 * attachments are released first: if settling then fails, the message is
 * settled again and released again, which is harmless, rather than settled
 * with its staged files left behind.
 */
async function settle(
  db: Db,
  id: string,
  status: "done" | "failed",
  error: string | null,
  payload: unknown,
) {
  await releaseStaged(db, payload);
  const { error: updateError } = await db
    .from("intake_inbound")
    .update({
      status,
      payload: null,
      error: error ? clip(error, 200) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending");
  if (updateError) throw updateError;
}

/** Remove an email's staged attachments, once nothing will read them. */
async function releaseStaged(db: Db, payload: unknown) {
  const keys = stagedKeys(payload);
  if (keys.length) await enqueueStorageCleanup(db, keys);
}

function requireSlackToken(settings: AutomationRow | null): string {
  const token = settings ? slackBotToken(settings) : null;
  if (!token)
    throw new NonRetryableJobError(
      "Slack isn't connected. Save the bot token in Intake settings.",
    );
  return token;
}

function emailMessage(payload: EmailInboundPayload): InboundMessage {
  const email = payload.from.email;
  return {
    source: "email",
    sender: {
      name: payload.from.name ?? email?.split("@")[0] ?? "Unknown sender",
      email,
    },
    sentAt: new Date(payload.date),
    subject: payload.subject,
    subjectHint: payload.subject,
    text: payload.text,
    candidates: payload.attachments.map((a) => ({
      name: a.name,
      file_type: a.file_type,
      size: a.size,
      key: a.key,
      url: null,
    })),
    skipped: payload.skipped,
  };
}

const slackDate = (ts: string) => new Date(Number(ts.split(".")[0]) * 1000);

/** Slack's files on the request, held to the same limits as an email's. */
function slackAttachments(files: SlackInboundPayload["files"]): {
  candidates: AttachmentCandidate[];
  skipped: SkippedAttachment[];
} {
  const candidates: AttachmentCandidate[] = [];
  const skipped: SkippedAttachment[] = [];
  for (const file of files) {
    const fileType = documentSuffix(file.name);
    if (!ALLOWED_DOCUMENT_TYPES.has(fileType))
      skipped.push({ name: file.name, reason: "type" });
    else if (file.size !== null && file.size > MAX_ATTACHMENT_BYTES)
      skipped.push({ name: file.name, reason: "size" });
    else if (!file.url) skipped.push({ name: file.name, reason: "unreadable" });
    else if (candidates.length >= MAX_ATTACHMENTS)
      skipped.push({ name: file.name, reason: "count" });
    else
      candidates.push({
        name: file.name,
        file_type: fileType,
        size: file.size,
        key: null,
        url: file.url,
      });
  }
  return { candidates, skipped };
}

function fileRefs(files: SlackFile[] | undefined): SlackInboundPayload["files"] {
  return (files ?? [])
    .filter((f) => f.mode !== "tombstone" && f.mode !== "external" && !f.is_external)
    .map((f) => ({
      id: f.id ?? null,
      name: clip(cleanText(f.name || f.title || ""), 255) || "Slack file",
      size: typeof f.size === "number" ? f.size : null,
      url: f.url_private_download ?? null,
    }));
}

/**
 * The Slack request: the mentioning message, or the whole thread up to the
 * mention, whose first author is then the requester. People are named from
 * Slack; one that can't be looked up is still recorded, unnamed.
 */
async function slackMessage(
  token: string,
  settings: AutomationRow | null,
  payload: SlackInboundPayload,
): Promise<InboundMessage> {
  const botUserId = settings?.slack_bot_user_id ?? null;
  type Message = {
    user: string | null;
    ts: string;
    text: string;
    files: SlackInboundPayload["files"];
  };
  let messages: Message[] = [
    { user: payload.user, ts: payload.ts, text: payload.text, files: payload.files },
  ];
  if (payload.thread_ts) {
    const thread = await slackThreadMessages(
      token,
      payload.channel,
      payload.thread_ts,
      payload.ts,
    );
    const read = thread
      .filter((m) => !botUserId || m.user !== botUserId)
      .map((m) => ({
        user: m.user ?? null,
        ts: m.ts,
        text: cleanText(m.text ?? ""),
        files: fileRefs(m.files),
      }))
      .filter((m) => m.text.trim() || m.files.length);
    // The thread as far as it could be read, ending with the mention even
    // when the read stopped short of it.
    if (read.length)
      messages = read.some((m) => m.ts === payload.ts) ? read : [...read, messages[0]!];
  }
  const requester = messages[0]!.user ?? payload.user;
  const ids = [
    ...new Set([
      requester,
      ...messages.flatMap((m) => (m.user ? [m.user] : [])),
      ...messages.flatMap((m) => mentionedUsers(m.text)),
    ]),
  ]
    .filter((id) => id !== botUserId)
    .slice(0, 30);
  const people = new Map<string, SlackPerson>();
  for (const id of ids) {
    try {
      const person = await slackUserInfo(token, id);
      if (person) people.set(id, person);
    } catch (error) {
      // Without users:read the request is still recorded; a token Slack
      // refuses outright stops here.
      if (error instanceof SlackApiError && SLACK_TOKEN_ERRORS.has(error.code))
        throw error;
    }
  }
  const names = new Map(
    [...people].flatMap(([id, p]) => (p.name ? [[id, p.name] as const] : [])),
  );
  const nameOf = (id: string | null) => (id && names.get(id)) || "Slack user";
  const plain = messages.map((m) => ({
    ...m,
    text: slackTextToPlain(m.text, names, botUserId),
  }));
  const text =
    plain.length === 1
      ? plain[0]!.text
      : plain
          .map((m) => `${nameOf(m.user)}, ${formatSent(slackDate(m.ts))}:\n${m.text}`)
          .join("\n\n");
  const seen = new Set<string>();
  const files = plain
    .flatMap((m) => m.files)
    .filter((f) => {
      const key = f.id ?? f.url ?? f.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const firstLine =
    plain[0]!.text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? null;
  return {
    source: "slack",
    sender: { name: nameOf(requester), email: people.get(requester)?.email ?? null },
    sentAt: slackDate(messages[0]!.ts),
    subject: null,
    subjectHint: firstLine,
    text: clip(text, MAX_MESSAGE_CHARS),
    ...slackAttachments(files),
  };
}

/**
 * Record the request. A plan the database refuses is recorded once more
 * without its date and requester email, which are the fields a model or a
 * sender could get wrong.
 */
async function submit(db: Db, row: InboundRow, plan: TriagePlan): Promise<string> {
  const args = (p: TriagePlan) => ({
    p_org: row.org_id,
    p_inbound: row.id,
    p_request: row.id,
    p_subject: p.subject,
    p_description: p.description,
    p_requester_name: p.requester_name,
    p_requester_email: p.requester_email,
    p_date: p.requested_by_date,
    p_assignee: p.assignee_id,
  });
  let result = await intakeRpc<string>(db, "intake_submit_automated", args(plan));
  if (!result.ok && result.kind === "validation")
    result = await intakeRpc<string>(
      db,
      "intake_submit_automated",
      args({ ...plan, requester_email: null, requested_by_date: null }),
    );
  if (result.ok) return result.data;
  if (result.kind === "error") throw result.error;
  throw new NonRetryableJobError(
    result.kind === "validation"
      ? "The message's details couldn't be recorded as a request."
      : GENERIC_FAILURE,
  );
}

/**
 * Make one attachment MikeGC's document on the request, as an upload is
 * made: linked before any bytes are written, so it never belongs to no
 * request, then given its version and marked ready. A Word or PowerPoint file
 * is queued for the PDF rendition the viewer opens. Returns false when the
 * request is gone.
 */
async function addDocument(
  db: Db,
  args: {
    orgId: string;
    requestId: string;
    entry: { document_id: string; version_id: string };
    name: string;
    fileType: string;
    bytes: ArrayBuffer;
  },
): Promise<boolean> {
  const { orgId, entry } = args;
  const documentId = entry.document_id;
  const { error: insertError } = await db.from("documents").upsert(
    {
      id: documentId,
      user_id: null,
      org_id: orgId,
      status: "processing",
      library_kind: "intake_attachment",
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (insertError) throw insertError;
  const attached = await intakeRpc<null>(db, "intake_attach_automated", {
    p_org: orgId,
    p_request: args.requestId,
    p_document: documentId,
  });
  if (!attached.ok) {
    await db.from("documents").delete().eq("id", documentId);
    if (attached.kind === "not_found") return false;
    if (attached.kind === "error") throw attached.error;
    throw new IntakeAutomationError(RECORDED_INCOMPLETE);
  }
  const key = storageKey(ownerSegment(orgId), documentId, args.name);
  try {
    await uploadFile(key, args.bytes, contentTypeForDocumentType(args.fileType));
    const { error: versionError } = await createDocumentVersion(db, {
      id: entry.version_id,
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: args.fileType === "pdf" ? key : null,
      source: "upload",
      version_number: 1,
      filename: args.name,
      file_type: args.fileType,
      size_bytes: args.bytes.byteLength,
      page_count: null,
      textless_page_count: null,
      content_sha256: contentSha256(args.bytes),
    });
    if (versionError) throw versionError;
    const { error: readyError } = await db
      .from("documents")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", documentId);
    if (readyError) throw readyError;
  } catch (error) {
    await Promise.all([
      deleteFileBestEffort(key, "intake-automation-rollback"),
      db.from("documents").delete().eq("id", documentId),
    ]);
    throw error;
  }
  if (shouldConvertToPdf(args.fileType)) {
    try {
      await enqueueConversion({
        documentId,
        versionId: entry.version_id,
        userId: ownerSegment(orgId),
        storagePath: key,
        fileType: args.fileType,
        pdfKey: convertedPdfKey(ownerSegment(orgId), documentId),
        finalizeDocumentStatus: false,
      });
    } catch (error) {
      // The document still opens as its original file.
      console.warn("[intake-automation] rendition not queued", safeError(error));
    }
  }
  return true;
}

async function addDocuments(
  db: Db,
  row: InboundRow,
  payload: InboundPayload,
  plan: TriagePlan,
  requestId: string,
  slackToken: string | null,
) {
  payload.documents ??= {};
  for (const index of plan.attachments) {
    const candidate = plan.candidates[index];
    if (!candidate) continue;
    let entry = payload.documents[String(index)];
    if (entry?.done) continue;
    if (!entry) {
      // Named before it is made, so a retry makes this same document.
      entry = { document_id: randomUUID(), version_id: randomUUID(), done: false };
      payload.documents[String(index)] = entry;
      await savePayload(db, row.id, payload);
    }
    const bytes = candidate.key
      ? await downloadFile(candidate.key)
      : candidate.url && slackToken
        ? await downloadSlackFile(slackToken, candidate.url, MAX_ATTACHMENT_BYTES)
        : null;
    if (!bytes) {
      // Larger than Slack said, or an email's staged copy is gone.
      if (candidate.key) throw new Error("Staged intake attachment is missing");
      entry.done = true;
      await savePayload(db, row.id, payload);
      continue;
    }
    const added = await addDocument(db, {
      orgId: row.org_id,
      requestId,
      entry,
      name: candidate.name,
      fileType: candidate.file_type,
      bytes,
    });
    if (!added) return;
    entry.done = true;
    await savePayload(db, row.id, payload);
  }
}

/** The link to a request, in the workspace the web app names it by. */
async function requestLink(db: Db, orgId: string, requestId: string) {
  const workspace = (await isPersonalOrg(db, orgId)) ? "personal" : orgId;
  return `${configuredFrontendUrl()}/intake/${requestId}?org=${encodeURIComponent(workspace)}`;
}

/** The thread's answer, or null when the request has since been deleted. */
async function recordedReply(
  db: Db,
  orgId: string,
  requestId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("intake_requests")
    .select("subject, assignee_id")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  const request = data as { subject: string; assignee_id: string | null } | null;
  if (!request) return null;
  let assignee: string | null = null;
  if (request.assignee_id) {
    const profile = await db
      .from("user_profiles")
      .select("display_name, email")
      .eq("user_id", request.assignee_id)
      .maybeSingle();
    if (profile.error) throw profile.error;
    const p = profile.data as { display_name: string | null; email: string | null } | null;
    assignee = p?.display_name?.trim() || p?.email || null;
  }
  const link = await requestLink(db, orgId, requestId);
  const subject = slackEscape(request.subject);
  return (
    `Logged for Legal: <${link}|${subject}>. ` +
    (assignee
      ? `Assigned to ${slackEscape(assignee)}.`
      : "Not assigned to a reviewer yet.")
  );
}

const FAILED_REPLY =
  "Sorry, I couldn't log this for Legal. Please try again, or contact the Legal team directly.";

async function replyInThread(token: string, payload: SlackInboundPayload, text: string) {
  await slackPostMessage(token, {
    channel: payload.channel,
    threadTs: payload.thread_ts ?? payload.ts,
    text,
  });
}

async function processInbound(db: Db, row: InboundRow): Promise<Record<string, unknown>> {
  const parsed = inboundPayload.safeParse(row.payload);
  if (!parsed.success)
    throw new NonRetryableJobError("The received message couldn't be read.");
  const payload = parsed.data;
  const settings = await loadAutomationRow(db, row.org_id);
  const slackToken = payload.kind === "slack" ? requireSlackToken(settings) : null;

  if (!payload.plan) {
    const message =
      payload.kind === "email"
        ? emailMessage(payload)
        : await slackMessage(slackToken!, settings, payload);
    // Triage runs with the model the organization chose; without one, or
    // once its key has gone, the message is recorded as it arrived.
    const [rules, model] = await Promise.all([
      loadTriageRules(db, row.org_id),
      resolveIntakeModel(
        db,
        row.org_id,
        settings?.configured_by ?? null,
        settings?.triage_model ?? null,
      ),
    ]);
    payload.plan = await triageInbound({
      message,
      rules,
      model,
    });
    await savePayload(db, row.id, payload);
  }
  const plan = payload.plan;
  // Recorded, then deleted before this run: it stays deleted.
  if (payload.recorded && !row.request_id) {
    await settle(db, row.id, "done", null, payload);
    return { request_id: null, deleted: true };
  }
  const requestId = row.request_id ?? (await submit(db, row, plan));
  if (!payload.recorded) {
    payload.recorded = true;
    await savePayload(db, row.id, payload);
  }
  await addDocuments(db, row, payload, plan, requestId, slackToken);
  // Once its documents are attached, so preprocessing reads them.
  if (plan.preprocess && !payload.preprocessQueued) {
    await queueIntakePreprocess(db, {
      orgId: row.org_id,
      requestId,
      with: plan.preprocess.with,
    });
    payload.preprocessQueued = true;
    await savePayload(db, row.id, payload);
  }
  if (payload.kind === "slack" && !payload.replied) {
    const reply = await recordedReply(db, row.org_id, requestId);
    if (reply) await replyInThread(slackToken!, payload, reply);
    payload.replied = true;
    await savePayload(db, row.id, payload);
  }
  await settle(db, row.id, "done", null, payload);
  return { request_id: requestId, triaged: plan.triaged };
}

/**
 * The job body. A message no longer waiting (handled, or purged with the
 * organization's intake data) is skipped. A failure records the reason an
 * admin will see, then is thrown: retried with backoff, or failed at once
 * when retrying cannot help.
 */
export async function handleIntakeInbound(
  db: Db,
  job: DbJob,
): Promise<Record<string, unknown>> {
  const ids = jobPayload.safeParse(job.payload);
  if (!ids.success) throw new NonRetryableJobError("intake.inbound: invalid payload");
  const row = await loadInbound(db, ids.data);
  if (!row) return { skipped: "missing" };
  if (row.status !== "pending") return { skipped: row.status };
  try {
    return await processInbound(db, row);
  } catch (error) {
    const reason =
      error instanceof NonRetryableJobError ? error.message : adminMessage(error);
    await db
      .from("intake_inbound")
      .update({ error: clip(reason, 200), updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .then(undefined, () => undefined);
    if (isPermanentSlackError(error))
      throw new NonRetryableJobError(reason);
    throw error;
  }
}

/**
 * When a message's job has failed for good: mark it failed with the reason
 * already recorded, drop its content and staged files, and tell the Slack
 * thread. A request that was recorded keeps its link, and the thread is
 * pointed to it rather than told nothing was logged.
 */
export async function markIntakeInboundFailed(db: Db, job: DbJob): Promise<void> {
  const ids = jobPayload.safeParse(job.payload);
  if (!ids.success) return;
  const row = await loadInbound(db, ids.data);
  if (!row || row.status !== "pending") return;
  const parsed = inboundPayload.safeParse(row.payload);
  const payload = parsed.success ? parsed.data : null;
  const reason = row.request_id ? RECORDED_INCOMPLETE : row.error ?? GENERIC_FAILURE;
  if (payload?.kind === "slack" && !payload.replied) {
    try {
      const settings = await loadAutomationRow(db, row.org_id);
      const token = settings ? slackBotToken(settings) : null;
      const reply = row.request_id
        ? await recordedReply(db, row.org_id, row.request_id)
        : FAILED_REPLY;
      if (token && reply) await replyInThread(token, payload, reply);
    } catch (error) {
      console.warn("[intake-automation] failure reply not sent", safeError(error));
    }
  }
  await settle(db, row.id, "failed", reason, row.payload);
}

/**
 * Queue a stored message's job. With the job runner switched off
 * (DB_JOBS_ENABLED=false) nothing would claim it, so it runs here, detached
 * from the webhook request, without retries.
 */
export async function dispatchIntakeInbound(
  db: Db,
  orgId: string,
  inboundId: string,
): Promise<void> {
  const payload = { inboundId, orgId };
  const dedupeKey = `${INTAKE_INBOUND_JOB}:${inboundId}`;
  if (!dbJobsEnabled()) {
    const now = new Date().toISOString();
    const job: DbJob = {
      id: `inline:${dedupeKey}`,
      kind: INTAKE_INBOUND_JOB,
      payload,
      status: "running",
      attempts: 1,
      max_attempts: 1,
      run_at: now,
      claimed_at: now,
      finished_at: null,
      last_error: null,
      dedupe_key: dedupeKey,
      result: null,
      created_at: now,
    };
    void handleIntakeInbound(db, job).catch(async (error) => {
      console.warn("[intake-automation] inline job failed", safeError(error));
      await markIntakeInboundFailed(db, job).catch(() => undefined);
    });
    return;
  }
  await enqueueDbJob(db, {
    kind: INTAKE_INBOUND_JOB,
    payload,
    dedupeKey,
    maxAttempts: JOB_ATTEMPTS,
  });
}
