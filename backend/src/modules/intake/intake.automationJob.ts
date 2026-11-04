import { z } from "zod";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { NonRetryableJobError, dbJobsEnabled } from "../../lib/dbq/runner";
import type { DbJob } from "../../lib/dbq/types";
import { safeError } from "../../lib/safeError";
import { deleteFile } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import { loadAutomationRow, type AutomationRow } from "./intake.settingsRow";
import { acknowledgeRequest, askRequester } from "./intake.outbox";
import {
  IntakeAutomationError,
  RECORDED_INCOMPLETE,
  addDocuments,
  channelAttachments,
  type CandidateDownloader,
} from "./intake.attachments";
import {
  linkThread,
  loadRequestLink,
  type ChannelSource,
} from "./intake.channels";
import { MAX_CLARIFY_ROUNDS, stableId } from "./intake.clarify";
import { requestLink } from "./intake.deliver";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_CHARS,
  cleanText,
  clip,
  inboundPayload,
  stagedKeys,
  type EmailInboundPayload,
  type InboundPayload,
  type MailInboundPayload,
  type SlackInboundPayload,
  type TriagePlan,
} from "./intake.inboundPayload";
import { mailThread, recordEmailMessageIds } from "./intake.mail";
import { queueIntakePreprocess } from "./intake.preprocess";
import { slackBotToken } from "./intake.secrets";
import { dispatchIntakeJob, intakeRpc } from "./intake.shared";
import {
  SLACK_TOKEN_ERRORS,
  SlackApiError,
  downloadSlackFile,
  isPermanentSlackError,
  mentionedUsers,
  slackChannelName,
  slackPermalink,
  slackPostMessage,
  slackTextToPlain,
  slackThreadMessages,
  slackUserInfo,
  type SlackFile,
  type SlackPerson,
} from "./intake.slack";
import {
  TeamsApiError,
  isPermanentTeamsError,
  teamsDownloadFile,
  teamsInboundMessage,
  teamsThread,
} from "./intake.teams";
import {
  formatSent,
  loadTriageRules,
  resolveIntakeModel,
  triageInbound,
  type InboundMessage,
} from "./intake.triage";

/**
 * The intake.inbound job: triage a received message, record it as MikeGC's
 * request, add its documents, link the request to its thread and answer
 * there: with MikeGC's questions when it needs more to choose a rule, else
 * with an acknowledgement (which waits for the readiness check when the
 * rule's preprocessing may ask too). Every step can run again: the plan,
 * each document's ids and each step done are saved on the message as they
 * happen, and recording the request is keyed by the message.
 */

export const INTAKE_INBOUND_JOB = "intake.inbound";
const JOB_ATTEMPTS = 4;

const GENERIC_FAILURE = "MikeGC couldn't record this message. Try sending it again.";

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
  if (error instanceof TeamsApiError) return error.sentence;
  return GENERIC_FAILURE;
}

type InboundRow = {
  id: string;
  org_id: string;
  source: "email" | ChannelSource;
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
export async function saveInboundPayload(db: Db, id: string, payload: unknown) {
  const { error } = await db
    .from("intake_inbound")
    .update({ payload, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw error;
}

/**
 * Leave the waiting state for good, dropping the content. Staged
 * attachments are released first: if settling then fails, the message is
 * settled again and released again, which is harmless, rather than settled
 * with its staged files left behind.
 */
export async function settleInbound(
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

/**
 * Remove a message's staged attachments, once nothing will read them: a
 * storage.cleanup job, or with the job runner off, which would never run it,
 * deleted now. Unlike enqueueStorageCleanup this throws when neither is
 * certain, so the message keeps its payload, and with it the keys, until a
 * retry succeeds.
 */
async function releaseStaged(db: Db, payload: unknown) {
  const keys = stagedKeys(payload);
  if (keys.length === 0) return;
  if (!dbJobsEnabled()) {
    for (const key of keys) await deleteFile(key);
    return;
  }
  await enqueueDbJob(db, {
    kind: "storage.cleanup",
    payload: { keys, prefixes: [] },
    maxAttempts: 8,
  });
}

function requireSlackToken(settings: AutomationRow | null): string {
  const token = settings ? slackBotToken(settings) : null;
  if (!token)
    throw new NonRetryableJobError(
      "Slack isn't connected. Save the bot token in Intake settings.",
    );
  return token;
}

/** A Postmark email, recorded before MikeGC read the mailbox itself. */
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

/** An email to the intake mailbox, read through Graph or the Gmail API. */
function mailMessage(payload: MailInboundPayload): InboundMessage {
  const email = payload.from.email;
  return {
    source: payload.provider === "graph" ? "outlook" : "gmail",
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

export function slackFileRefs(files: SlackFile[] | undefined): SlackInboundPayload["files"] {
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
        files: slackFileRefs(m.files),
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
    ...channelAttachments(files, "slack"),
  };
}

/** The message as triage reads it, whichever channel it came from. */
async function inboundMessage(
  settings: AutomationRow | null,
  payload: InboundPayload,
): Promise<InboundMessage> {
  switch (payload.kind) {
    case "email":
      return emailMessage(payload);
    case "mail":
      return mailMessage(payload);
    case "slack":
      return slackMessage(requireSlackToken(settings), settings, payload);
    case "teams":
      if (!settings) throw new NonRetryableJobError("Teams isn't connected.");
      return teamsInboundMessage(settings, payload);
  }
}

/** The channel a message can be answered in; Postmark email has none. */
function channelOf(payload: InboundPayload): ChannelSource | null {
  switch (payload.kind) {
    case "slack":
      return "slack";
    case "mail":
      return payload.provider === "graph" ? "outlook" : "gmail";
    case "teams":
      return "teams";
    case "email":
      return null;
  }
}

/** The thread to link a request to: its key and what posting there needs. */
async function threadOf(
  settings: AutomationRow,
  payload: InboundPayload,
): Promise<{ source: ChannelSource; key: string; address: Record<string, unknown> } | null> {
  switch (payload.kind) {
    case "email":
      return null;
    case "slack": {
      const token = requireSlackToken(settings);
      const root = payload.thread_ts ?? payload.ts;
      const team = payload.team_id ?? settings.slack_team_id ?? "";
      const [channelName, permalink] = await Promise.all([
        slackChannelName(token, payload.channel),
        slackPermalink(token, payload.channel, root),
      ]);
      return {
        source: "slack",
        key: `${team}:${payload.channel}:${root}`,
        address: {
          team_id: team || null,
          channel: payload.channel,
          thread_ts: root,
          channel_name: channelName,
          permalink,
        },
      };
    }
    case "mail":
      return mailThread(settings, payload);
    case "teams":
      return teamsThread(payload);
  }
}

/** Link a recorded request to the thread its message came from. */
async function linkRequestThread(
  db: Db,
  orgId: string,
  requestId: string,
  settings: AutomationRow,
  payload: InboundPayload,
) {
  const thread = await threadOf(settings, payload);
  if (!thread) return;
  const linkId = await linkThread(db, {
    orgId,
    requestId,
    source: thread.source,
    threadKey: thread.key,
    address: thread.address,
  });
  if (linkId && payload.kind === "mail")
    await recordEmailMessageIds(db, orgId, linkId, [payload.message_id]);
}

/** Download a channel file for an attachment. */
function downloader(settings: AutomationRow | null): CandidateDownloader {
  return async (candidate) => {
    if (!candidate.url || !settings) return null;
    if (candidate.via === "teams")
      return teamsDownloadFile(settings, candidate.url, MAX_ATTACHMENT_BYTES);
    const token = slackBotToken(settings);
    return token ? downloadSlackFile(token, candidate.url, MAX_ATTACHMENT_BYTES) : null;
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

/** A note on the request whose thread this mail arrived in, linking to it. */
async function noteRelated(
  db: Db,
  row: InboundRow,
  relatedId: string,
  requestId: string,
  sender: string | null,
) {
  const link = await requestLink(db, row.org_id, requestId);
  const note = await intakeRpc<boolean>(db, "intake_note_automated", {
    p_org: row.org_id,
    p_request: relatedId,
    p_note: stableId(`intake.related:${row.id}`),
    p_body:
      `A message in this request's email thread came from ${sender ?? "someone"}, who isn't on the thread, ` +
      `so MikeGC recorded it as a new request: ${link}`,
  });
  if (!note.ok && note.kind !== "not_found")
    throw note.kind === "error" ? note.error : new Error(note.detail);
}

async function processInbound(db: Db, row: InboundRow): Promise<Record<string, unknown>> {
  const parsed = inboundPayload.safeParse(row.payload);
  if (!parsed.success)
    throw new NonRetryableJobError("The received message couldn't be read.");
  const payload = parsed.data;
  const save = () => saveInboundPayload(db, row.id, payload);
  const settings = await loadAutomationRow(db, row.org_id);
  const channel = channelOf(payload);
  // MikeGC asks only where it can be answered: in a thread of the request's
  // own. Mail in another request's thread is recorded apart, and the thread
  // stays that request's, so questions planned for it could never be sent
  // while the rule's reviewer waited on them.
  const canAsk =
    !!channel && !(payload.kind === "mail" && payload.related_request_id);

  if (!payload.plan) {
    const message = await inboundMessage(settings, payload);
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
    const plan = await triageInbound({ message, rules, model });
    // With questions, the rule is undecided: recorded unassigned, waiting.
    if (plan.questions.length && canAsk && MAX_CLARIFY_ROUNDS > 0) {
      plan.assignee_id = null;
      plan.preprocess = null;
    } else plan.questions = [];
    payload.plan = plan;
    await save();
  }
  const plan = payload.plan;
  // Recorded, then deleted before this run: it stays deleted.
  if (payload.recorded && !row.request_id) {
    await settleInbound(db, row.id, "done", null, payload);
    return { request_id: null, deleted: true };
  }
  const requestId = row.request_id ?? (await submit(db, row, plan));
  if (!payload.recorded) {
    payload.recorded = true;
    await save();
  }
  if (channel && settings && !payload.linked) {
    await linkRequestThread(db, row.org_id, requestId, settings, payload);
    payload.linked = true;
    await save();
  }
  payload.documents ??= {};
  const attached = await addDocuments(db, {
    orgId: row.org_id,
    requestId,
    candidates: plan.candidates,
    chosen: plan.attachments,
    documents: payload.documents,
    save,
    download: downloader(settings),
  });
  if (!attached) {
    // The request was deleted while its documents were being added.
    await settleInbound(db, row.id, "done", null, payload);
    return { request_id: null, deleted: true };
  }
  if (payload.kind === "mail" && payload.related_request_id && !payload.relatedNoted) {
    await noteRelated(db, row, payload.related_request_id, requestId, payload.from.email);
    payload.relatedNoted = true;
    await save();
  }
  const linked = !!(await loadRequestLink(db, row.org_id, requestId));
  // Questions to choose a rule go in the acknowledgement.
  if (plan.questions.length && !payload.acknowledged) {
    const asked =
      linked &&
      (await askRequester(db, {
        orgId: row.org_id,
        requestId,
        seed: `${requestId}:rule:0`,
        questions: plan.questions,
        stage: "rule",
        acknowledge: true,
      }));
    if (!asked && linked) await acknowledgeRequest(db, row.org_id, requestId);
    payload.acknowledged = true;
    await save();
  }
  // Once its documents are attached, so preprocessing reads them. When its
  // readiness check may ask, the acknowledgement waits for it, so any
  // questions go in the same message.
  const deferAcknowledgement = !!plan.preprocess && linked && canAsk;
  if (plan.preprocess && !payload.preprocessQueued) {
    await queueIntakePreprocess(db, {
      orgId: row.org_id,
      requestId,
      with: plan.preprocess.with,
      condition: plan.preprocess.condition ?? null,
      round: 0,
      acknowledge: deferAcknowledgement && !payload.acknowledged,
    });
    payload.preprocessQueued = true;
    if (deferAcknowledgement) payload.acknowledged = true;
    await save();
  }
  if (!payload.acknowledged && !payload.replied) {
    if (linked) await acknowledgeRequest(db, row.org_id, requestId);
    payload.acknowledged = true;
    await save();
  }
  await settleInbound(db, row.id, "done", null, payload);
  return {
    request_id: requestId,
    triaged: plan.triaged,
    asked: plan.questions.length > 0,
  };
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
    if (isPermanentSlackError(error) || isPermanentTeamsError(error))
      throw new NonRetryableJobError(reason);
    throw error;
  }
}

const FAILED_REPLY =
  "Sorry, I couldn't log this for Legal. Please try again, or contact the Legal team directly.";

/**
 * When a message's job has failed for good: mark it failed with the reason
 * already recorded, and drop its content and staged files. A request that
 * was recorded keeps its link, and its thread is acknowledged rather than
 * told nothing was logged; a Slack thread with no request is told so.
 */
export async function markIntakeInboundFailed(db: Db, job: DbJob): Promise<void> {
  const ids = jobPayload.safeParse(job.payload);
  if (!ids.success) return;
  const row = await loadInbound(db, ids.data);
  if (!row || row.status !== "pending") return;
  const parsed = inboundPayload.safeParse(row.payload);
  const payload = parsed.success ? parsed.data : null;
  const reason = row.request_id ? RECORDED_INCOMPLETE : row.error ?? GENERIC_FAILURE;
  if (payload && !payload.acknowledged && !payload.replied) {
    try {
      if (row.request_id) {
        // Failed before its thread was linked: link it, so the thread hears.
        const settings = payload.linked ? null : await loadAutomationRow(db, row.org_id);
        if (settings && channelOf(payload))
          await linkRequestThread(db, row.org_id, row.request_id, settings, payload);
        await acknowledgeRequest(db, row.org_id, row.request_id);
      } else if (payload.kind === "slack") {
        const settings = await loadAutomationRow(db, row.org_id);
        const token = settings ? slackBotToken(settings) : null;
        if (token)
          await slackPostMessage(token, {
            channel: payload.channel,
            threadTs: payload.thread_ts ?? payload.ts,
            text: FAILED_REPLY,
          });
      }
    } catch (error) {
      console.warn("[intake-automation] failure reply not sent", safeError(error));
    }
  }
  await settleInbound(db, row.id, "failed", reason, row.payload);
}

/** Queue a stored message's job. */
export async function dispatchIntakeInbound(
  db: Db,
  orgId: string,
  inboundId: string,
): Promise<void> {
  await dispatchIntakeJob(db, {
    kind: INTAKE_INBOUND_JOB,
    payload: { inboundId, orgId },
    dedupeKey: `${INTAKE_INBOUND_JOB}:${inboundId}`,
    maxAttempts: JOB_ATTEMPTS,
    handler: handleIntakeInbound,
    onFailure: markIntakeInboundFailed,
  });
}
