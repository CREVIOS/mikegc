import { z } from "zod";
import type { IntakeExternalAuthor } from "@mike/contracts";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import type { DbJob } from "../../lib/dbq/types";
import { safeError } from "../../lib/safeError";
import type { Db } from "../../lib/supabase";
import {
  addDocuments,
  channelAttachments,
  type CandidateDownloader,
} from "./intake.attachments";
import {
  saveInboundPayload,
  settleInbound,
  slackFileRefs,
} from "./intake.automationJob";
import {
  loadRequestLink,
  updateLinkAddress,
  type ChannelLink,
} from "./intake.channels";
import { MAX_CLARIFY_ROUNDS, stableId } from "./intake.clarify";
import {
  MAX_ATTACHMENT_BYTES,
  cleanText,
  clip,
  replyPayload,
  type AttachmentCandidate,
  type ReplyPayload,
  type SkippedAttachment,
} from "./intake.inboundPayload";
import { recordEmailMessageIds } from "./intake.mail";
import {
  askRequester,
  loadThreadEntries,
  settleClarify,
} from "./intake.outbox";
import {
  queueIntakePreprocess,
  queueNextIntakePreprocess,
} from "./intake.preprocess";
import { slackBotToken } from "./intake.secrets";
import { loadAutomationRow, type AutomationRow } from "./intake.settingsRow";
import { dispatchIntakeJob, intakeRpc } from "./intake.shared";
import {
  SlackApiError,
  downloadSlackFile,
  isPermanentSlackError,
  mentionedUsers,
  slackTextToPlain,
  slackThreadMessage,
  slackUserInfo,
} from "./intake.slack";
import {
  isPermanentTeamsError,
  teamsDownloadFile,
  teamsMemberEmail,
} from "./intake.teams";
import {
  CHANNEL_NAMES,
  SKIPPED_REASON,
  loadTriageRules,
  resolveIntakeModel,
  triageInbound,
  type InboundMessage,
} from "./intake.triage";

/**
 * The intake.reply job: a requester's message in a request's thread. It is
 * recorded on the request as a reply, with its files as the request's
 * documents, and when it answers MikeGC's questions, the stage that asked
 * runs again: triage to choose a rule, or the next round of preprocessing's
 * readiness check. An answer to a lawyer's question runs no AI.
 */

export const INTAKE_REPLY_JOB = "intake.reply";
const JOB_ATTEMPTS = 4;
const BODY_MAX = 20_000;

const jobPayload = z.object({ inboundId: z.uuid(), orgId: z.uuid() });

type ReplyRow = {
  id: string;
  org_id: string;
  kind: "request" | "reply";
  status: "pending" | "done" | "failed" | "ignored";
  payload: unknown;
  request_id: string | null;
};

async function loadReply(
  db: Db,
  ids: { inboundId: string; orgId: string },
): Promise<ReplyRow | null> {
  const { data, error } = await db
    .from("intake_inbound")
    .select("id, org_id, kind, status, payload, request_id")
    .eq("id", ids.inboundId)
    .eq("org_id", ids.orgId)
    .maybeSingle();
  if (error) throw error;
  return (data as ReplyRow | null) ?? null;
}

type ReplyContent = {
  text: string;
  author: IntakeExternalAuthor;
  candidates: AttachmentCandidate[];
  skipped: SkippedAttachment[];
};

/** A Slack reply, read from Slack: null once it has been deleted. */
async function slackReply(
  settings: AutomationRow,
  payload: Extract<ReplyPayload, { kind: "slack_reply" }>,
): Promise<ReplyContent | null> {
  const token = slackBotToken(settings);
  if (!token)
    throw new NonRetryableJobError(
      "Slack isn't connected. Save the bot token in Intake settings.",
    );
  const message = await slackThreadMessage(token, {
    channel: payload.channel,
    threadTs: payload.thread_ts,
    ts: payload.ts,
  });
  if (!message) return null;
  const raw = cleanText(message.text ?? "");
  const ids = [...new Set([payload.user, ...mentionedUsers(raw)])].slice(0, 20);
  const names = new Map<string, string>();
  let author: { name: string | null; email: string | null } = { name: null, email: null };
  for (const id of ids) {
    try {
      const person = await slackUserInfo(token, id);
      if (person?.name) names.set(id, person.name);
      if (id === payload.user && person) author = person;
    } catch (error) {
      if (isPermanentSlackError(error)) throw error;
    }
  }
  return {
    text: slackTextToPlain(raw, names, settings.slack_bot_user_id),
    author: { ...author, source: "slack", user_id: payload.user },
    ...channelAttachments(slackFileRefs(message.files), "slack"),
  };
}

async function readReply(
  settings: AutomationRow,
  payload: ReplyPayload,
  link: ChannelLink,
): Promise<ReplyContent | null> {
  switch (payload.kind) {
    case "slack_reply":
      return slackReply(settings, payload);
    case "mail_reply":
      return {
        text: payload.text,
        author: {
          name: payload.from.name,
          email: payload.from.email,
          source: payload.provider === "graph" ? "outlook" : "gmail",
        },
        candidates: payload.attachments.map((a) => ({
          name: a.name,
          file_type: a.file_type,
          size: a.size,
          key: a.key,
          url: null,
        })),
        skipped: payload.skipped,
      };
    case "teams_reply": {
      const email = await teamsMemberEmail(settings, link, payload.from.id).catch(
        (error) => {
          if (isPermanentTeamsError(error)) throw error;
          return null;
        },
      );
      return {
        text: payload.text,
        author: {
          name: payload.from.name,
          email,
          source: "teams",
          user_id: payload.from.aad_object_id ?? payload.from.id,
        },
        ...channelAttachments(payload.files, "teams"),
      };
    }
  }
}

/** The reply as recorded: its text, then any files that couldn't be added. */
export function replyBody(content: ReplyContent): string {
  const files = content.candidates.map((c) => c.name);
  const text =
    content.text.trim() ||
    (files.length ? `Sent ${files.length === 1 ? "a file" : "files"}: ${files.join(", ")}` : "(No text.)");
  const skipped = content.skipped.length
    ? "\n\nNot attached:\n" +
      content.skipped.map((s) => `- ${s.name}: ${SKIPPED_REASON[s.reason]}`).join("\n")
    : "";
  const room = BODY_MAX - skipped.length;
  return (text.length > room ? clip(text, room - 30) + "\n[Reply shortened.]" : text) + skipped;
}

function downloader(settings: AutomationRow): CandidateDownloader {
  return async (candidate) => {
    if (!candidate.url) return null;
    if (candidate.via === "teams")
      return teamsDownloadFile(settings, candidate.url, MAX_ATTACHMENT_BYTES);
    const token = slackBotToken(settings);
    return token ? downloadSlackFile(token, candidate.url, MAX_ATTACHMENT_BYTES) : null;
  };
}

type ReplyResult = {
  request_id: string;
  message_id: string;
  state: string;
  assignee_id: string | null;
  clarify_stage: "rule" | "readiness" | null;
  clarify_rounds: number;
  clarify_stopped: boolean;
};

/**
 * Triage again over the request and its thread, now that the requester has
 * answered: ask once more while a round is left and a rule is still
 * undecided, or settle on the rule (or none) and start its preprocessing.
 */
async function rerunRule(
  db: Db,
  settings: AutomationRow,
  link: ChannelLink,
  reply: ReplyResult,
) {
  const { data, error } = await db
    .from("intake_requests")
    .select("subject, description, requester_name, requester_email, created_at")
    .eq("id", reply.request_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  const request = data as {
    subject: string;
    description: string;
    requester_name: string;
    requester_email: string | null;
    created_at: string;
  };
  const message: InboundMessage = {
    source: link.source,
    sender: { name: request.requester_name, email: request.requester_email },
    sentAt: new Date(request.created_at),
    subject: request.subject,
    subjectHint: request.subject,
    text: request.description,
    candidates: [],
    skipped: [],
    thread: await loadThreadEntries(db, link.org_id, reply.request_id),
  };
  const [rules, model] = await Promise.all([
    loadTriageRules(db, link.org_id),
    resolveIntakeModel(
      db,
      link.org_id,
      settings.configured_by,
      settings.triage_model,
    ),
  ]);
  const plan = await triageInbound({ message, rules, model });
  if (
    plan.questions.length &&
    !reply.clarify_stopped &&
    reply.clarify_rounds < MAX_CLARIFY_ROUNDS &&
    (await askRequester(db, {
      orgId: link.org_id,
      requestId: reply.request_id,
      seed: `${reply.request_id}:rule:${reply.clarify_rounds}`,
      questions: plan.questions,
      stage: "rule",
      acknowledge: false,
    }))
  )
    return;
  // Decided, or no rounds left: a request that matches no rule stays unassigned.
  const settled = await settleClarify(db, {
    orgId: link.org_id,
    requestId: reply.request_id,
    stage: "rule",
    assign: true,
    assigneeId: plan.assignee_id,
  });
  if (settled && plan.preprocess)
    await queueIntakePreprocess(db, {
      orgId: link.org_id,
      requestId: reply.request_id,
      with: plan.preprocess.with,
      condition: plan.preprocess.condition ?? null,
      round: reply.clarify_rounds,
    });
}

async function processReply(db: Db, row: ReplyRow): Promise<Record<string, unknown>> {
  const parsed = replyPayload.safeParse(row.payload);
  if (!parsed.success)
    throw new NonRetryableJobError("The received reply couldn't be read.");
  const payload = parsed.data;
  const save = () => saveInboundPayload(db, row.id, payload);
  const done = async (result: Record<string, unknown>) => {
    await settleInbound(db, row.id, "done", null, payload);
    return result;
  };
  // The request was deleted, or purged, since the reply arrived.
  if (!row.request_id) return done({ skipped: "request_gone" });
  const [settings, link] = await Promise.all([
    loadAutomationRow(db, row.org_id),
    loadRequestLink(db, row.org_id, row.request_id),
  ]);
  if (!settings || !link) return done({ skipped: "request_gone" });
  const content = await readReply(settings, payload, link);
  if (!content) return done({ skipped: "message_gone" });
  const messageId = stableId(`intake.reply:${row.id}`);
  const recorded = await intakeRpc<ReplyResult | null>(db, "intake_reply_automated", {
    p_org: row.org_id,
    p_inbound: row.id,
    p_message: messageId,
    p_body: replyBody(content),
    p_author: {
      name: content.author.name ? clip(content.author.name, 200) : null,
      email: content.author.email ? clip(content.author.email, 320) : null,
      source: content.author.source,
      ...(content.author.user_id ? { user_id: clip(content.author.user_id, 200) } : {}),
    },
  });
  if (!recorded.ok) {
    if (recorded.kind === "not_found") return done({ skipped: "request_gone" });
    throw recorded.kind === "error" ? recorded.error : new Error(recorded.detail);
  }
  const reply = recorded.data;
  if (!reply) return done({ skipped: "request_gone" });
  if (!payload.recorded) {
    payload.recorded = true;
    await save();
  }
  payload.documents ??= {};
  const attached = await addDocuments(db, {
    orgId: row.org_id,
    requestId: reply.request_id,
    candidates: content.candidates,
    chosen: content.candidates.map((_, i) => i),
    documents: payload.documents,
    save,
    download: downloader(settings),
    messageId,
  });
  if (!attached) return done({ skipped: "request_gone" });
  if (payload.kind === "mail_reply") {
    // Later replies thread on this one, the newest in the thread.
    await recordEmailMessageIds(db, row.org_id, link.id, [payload.message_id]);
    await updateLinkAddress(db, link, { reply_to_message_id: payload.provider_id });
  }
  if (payload.kind === "teams_reply")
    await updateLinkAddress(db, link, { service_url: payload.service_url });
  // An answer to MikeGC's question reruns the stage that asked.
  if (reply.clarify_stage === "rule") await rerunRule(db, settings, link, reply);
  else if (reply.clarify_stage === "readiness")
    await queueNextIntakePreprocess(db, row.org_id, reply.request_id);
  return done({
    request_id: reply.request_id,
    stage: reply.clarify_stage,
    files: content.candidates.length,
  });
}

/** The job body. A reply no longer waiting is skipped. */
export async function handleIntakeReply(
  db: Db,
  job: DbJob,
): Promise<Record<string, unknown>> {
  const ids = jobPayload.safeParse(job.payload);
  if (!ids.success) throw new NonRetryableJobError("intake.reply: invalid payload");
  const row = await loadReply(db, ids.data);
  if (!row) return { skipped: "missing" };
  if (row.status !== "pending" || row.kind !== "reply") return { skipped: row.status };
  try {
    return await processReply(db, row);
  } catch (error) {
    if (isPermanentSlackError(error) || isPermanentTeamsError(error))
      throw new NonRetryableJobError(
        error instanceof SlackApiError
          ? "MikeGC couldn't read a reply in Slack."
          : "MikeGC couldn't read a reply in Teams.",
      );
    throw error;
  }
}

/** When a reply's job has failed for good: settle it without its content. */
export async function markIntakeReplyFailed(db: Db, job: DbJob): Promise<void> {
  const ids = jobPayload.safeParse(job.payload);
  if (!ids.success) return;
  const row = await loadReply(db, ids.data);
  if (!row || row.status !== "pending") return;
  await settleInbound(
    db,
    row.id,
    "failed",
    `MikeGC couldn't record a reply in the request's ${channelName(row.payload)} thread.`,
    row.payload,
  ).catch((error) => console.warn("[intake-reply] not settled", safeError(error)));
}

function channelName(payload: unknown): string {
  const kind = (payload as { kind?: string } | null)?.kind;
  if (kind === "slack_reply") return CHANNEL_NAMES.slack;
  if (kind === "teams_reply") return CHANNEL_NAMES.teams;
  return "email";
}

/** Queue a stored reply's job. */
export async function dispatchIntakeReply(
  db: Db,
  orgId: string,
  inboundId: string,
): Promise<void> {
  await dispatchIntakeJob(db, {
    kind: INTAKE_REPLY_JOB,
    payload: { inboundId, orgId },
    dedupeKey: `${INTAKE_REPLY_JOB}:${inboundId}`,
    maxAttempts: JOB_ATTEMPTS,
    handler: handleIntakeReply,
    onFailure: markIntakeReplyFailed,
  });
}
