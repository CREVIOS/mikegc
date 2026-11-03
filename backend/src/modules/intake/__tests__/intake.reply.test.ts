import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { automatedIntakeRpc, memoryDb, type MemoryDb } from "./memoryDb";

const mocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  getEffectiveApiKeys: vi.fn(),
  envApiKeys: vi.fn(),
  createDocumentVersion: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFile: vi.fn(),
  enqueueDbJob: vi.fn(),
  enqueueConversion: vi.fn(),
}));
vi.mock("../../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/llm")>()),
  completeText: mocks.completeText,
}));
vi.mock("../../user/user.service", () => ({
  getEffectiveApiKeys: mocks.getEffectiveApiKeys,
  envApiKeys: mocks.envApiKeys,
}));
vi.mock("../../documents/documents.service", () => ({
  createDocumentVersion: mocks.createDocumentVersion,
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  uploadFile: mocks.uploadFile,
  downloadFile: mocks.downloadFile,
  deleteFile: mocks.deleteFile,
  deleteFileBestEffort: vi.fn(),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: mocks.enqueueDbJob }));
vi.mock("../../../lib/queue/conversionQueue", () => ({ enqueueConversion: mocks.enqueueConversion }));
import type { DbJob } from "../../../lib/dbq/types";
import { encryptString } from "../../../lib/mcp/client";
import { handleIntakeReply, markIntakeReplyFailed } from "../intake.reply";

const org = "00000000-0000-4000-8000-000000000001";
const owner = "00000000-0000-4000-8000-000000000002";
const sam = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-0000000000a1";
const inboundId = "00000000-0000-4000-8000-0000000000e2";
const env = { ...process.env };
let memory: MemoryDb;
let slackCalls: { method: string; params: Record<string, string> }[];

const job = (): DbJob => ({
  id: "job-1",
  kind: "intake.reply",
  payload: { inboundId, orgId: org },
  status: "running",
  attempts: 1,
  max_attempts: 4,
  run_at: "",
  claimed_at: "",
  finished_at: null,
  last_error: null,
  dedupe_key: `intake.reply:${inboundId}`,
  result: null,
  created_at: "",
});
const slackReply = { kind: "slack_reply", channel: "C42", ts: "1793611000.000500", thread_ts: "1793610840.000100", user: "U1" };
const request = () => memory.rows("intake_requests")[0]!;
const queued = (kind: string) =>
  mocks.enqueueDbJob.mock.calls.map(([, input]) => input).filter((input) => input.kind === kind);

function setup(options: {
  request?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  source?: string;
  linkAddress?: Record<string, unknown>;
  rulePreprocess?: boolean;
}) {
  const token = encryptString("xoxb-bot-token");
  memory = memoryDb(
    {
      organizations: [{ id: org, kind: "team" }],
      org_members: [
        { org_id: org, user_id: owner, role: "owner" },
        { org_id: org, user_id: sam, role: "member" },
      ],
      user_profiles: [
        { user_id: owner, display_name: "Olive Owner", email: "olive@firm.test", account_deletion_requested_at: null },
        { user_id: sam, display_name: "Sam Lawyer", email: "sam@firm.test", account_deletion_requested_at: null },
      ],
      intake_assignment_rules: [
        {
          id: "r1",
          org_id: org,
          position: 0,
          condition: "Customer contracts",
          assignee_id: sam,
          preprocess: options.rulePreprocess ?? false,
          preprocess_kind: null,
          preprocess_ref: null,
        },
      ],
      intake_automation: [
        {
          org_id: org,
          slack_enabled: true,
          slack_bot_user_id: "UBOT",
          slack_bot_token_encrypted: token.encrypted,
          slack_bot_token_iv: token.iv,
          slack_bot_token_tag: token.tag,
          triage_model: "claude-haiku-4-5",
          configured_by: owner,
        },
      ],
      intake_requests: [
        {
          id: requestId,
          org_id: org,
          subject: "Review the Acme NDA",
          description: "An NDA with Acme.\n\n--- Original message ---\nPlease review.",
          requester_name: "Jane Business",
          requester_email: "jane@acme.test",
          created_at: "2026-11-02T09:14:00.000Z",
          state: "needs_information",
          assignee_id: null,
          clarify_stage: null,
          clarify_rounds: 0,
          clarify_stopped: false,
          ...options.request,
        },
      ],
      intake_channel_links: [
        {
          id: "link-1",
          org_id: org,
          request_id: requestId,
          source: options.source ?? "slack",
          thread_key: "T1:C42:1793610840.000100",
          address: options.linkAddress ?? { channel: "C42", thread_ts: "1793610840.000100" },
        },
      ],
      intake_inbound: [
        {
          id: inboundId,
          org_id: org,
          source: options.source ?? "slack",
          kind: "reply",
          external_id: "C42:1793611000.000500",
          request_id: requestId,
          payload: options.payload ?? slackReply,
        },
      ],
      intake_messages: [],
      documents: [],
      intake_request_documents: [],
    },
    automatedIntakeRpc,
  );
}

function stubSlack(message: Record<string, unknown> | null) {
  slackCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://files.slack.com/")) return new Response(new Uint8Array([37, 80, 68, 70]));
      const method = target.replace("https://slack.com/api/", "");
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      slackCalls.push({ method, params });
      if (method === "conversations.replies")
        return Response.json({ ok: true, messages: message ? [message] : [] });
      if (method === "users.info")
        return Response.json({ ok: true, user: { real_name: "Jane Business", profile: { real_name: "Jane Business", email: "jane@acme.test" } } });
      return Response.json({ ok: false, error: "unknown_method" });
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-encryption-secret-for-intake";
  process.env.FRONTEND_URL = "https://mike.example.com/";
  process.env.DB_JOBS_ENABLED = "true";
  mocks.envApiKeys.mockReturnValue({});
  mocks.getEffectiveApiKeys.mockResolvedValue({ claude: "sk-org" });
  mocks.createDocumentVersion.mockImplementation(async (_db, version) => ({ data: { id: version.id }, error: null }));
  mocks.uploadFile.mockResolvedValue(undefined);
  mocks.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  mocks.enqueueDbJob.mockResolvedValue({ id: "job-2", deduped: false });
  stubSlack({
    ts: "1793611000.000500",
    user: "U1",
    text: "Acme is a customer. <@UBOT> here is the signed copy.",
    files: [{ id: "F9", name: "Acme NDA signed.pdf", size: 4, url_private_download: "https://files.slack.com/F9/nda.pdf" }],
  });
});
afterAll(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("a requester's reply in the thread", () => {
  it("is recorded with its author and files, and an answer to a lawyer's question runs no AI", async () => {
    setup({ request: { assignee_id: sam } });
    await expect(handleIntakeReply(memory.db, job())).resolves.toMatchObject({
      request_id: requestId,
      stage: null,
      files: 1,
    });
    expect(slackCalls.find((c) => c.method === "conversations.replies")?.params).toMatchObject({
      channel: "C42",
      ts: "1793610840.000100",
      latest: "1793611000.000500",
      inclusive: "true",
    });
    const [reply] = memory.rows("intake_messages");
    expect(reply).toMatchObject({
      kind: "reply",
      author_id: null,
      body: "Acme is a customer. here is the signed copy.",
      external_author: { name: "Jane Business", email: "jane@acme.test", source: "slack", user_id: "U1" },
    });
    // Its file is the request's document, tagged on the reply.
    expect(memory.rows("intake_request_documents")).toEqual([
      expect.objectContaining({ request_id: requestId, automated: true, message_id: reply!.id }),
    ]);
    // Back to work, with the queue's New reply flag up.
    expect(request()).toMatchObject({ state: "in_review" });
    expect(request().last_reply_at).toBeTruthy();
    expect(mocks.completeText).not.toHaveBeenCalled();
    expect(memory.rows("intake_inbound")[0]).toMatchObject({ status: "done", payload: null });
  });
  it("runs triage again over the thread when MikeGC asked to choose a rule, and settles on it", async () => {
    setup({ request: { clarify_stage: "rule", clarify_rounds: 1 }, rulePreprocess: true });
    memory.rows("intake_messages").push({
      id: "q1",
      org_id: org,
      request_id: requestId,
      kind: "question",
      automated: true,
      body: "Before Legal starts, MikeGC needs:\n1. Is Acme a customer or a supplier?",
      created_at: "2026-11-02T09:15:00.000Z",
    });
    mocks.completeText.mockResolvedValue(JSON.stringify({ subject: "x", rule: 1, questions: [] }));
    await handleIntakeReply(memory.db, job());
    const prompt = mocks.completeText.mock.calls[0]![0].user as string;
    expect(prompt).toContain("--- Thread after the request ---");
    expect(prompt).toContain("MikeGC, 2 Nov 2026, 09:15 UTC:\nBefore Legal starts, MikeGC needs:");
    expect(prompt).toContain("Jane Business (requester)");
    expect(prompt).toContain("Acme is a customer.");
    expect(request()).toMatchObject({ clarify_stage: null, assignee_id: sam, state: "in_review" });
    // The rule asks for preprocessing: its round follows the answer.
    expect(queued("intake.preprocess")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ requestId, round: 1, acknowledge: false, condition: "Customer contracts" }),
        dedupeKey: `intake.preprocess:${requestId}:1`,
      }),
    ]);
  });
  it("asks once more while a round is left, as a question rather than an acknowledgement", async () => {
    setup({ request: { clarify_stage: "rule", clarify_rounds: 1 } });
    mocks.completeText.mockResolvedValue(JSON.stringify({ rule: null, questions: ["What is the contract value?"] }));
    await handleIntakeReply(memory.db, job());
    expect(request()).toMatchObject({ clarify_stage: "rule", clarify_rounds: 2, state: "needs_information" });
    expect(memory.rows("intake_outbound")).toEqual([expect.objectContaining({ kind: "question" })]);
    expect(queued("intake.deliver")).toHaveLength(1);
  });
  it("leaves a request that matches no rule unassigned once the rounds are used up", async () => {
    setup({ request: { clarify_stage: "rule", clarify_rounds: 2 } });
    mocks.completeText.mockResolvedValue(JSON.stringify({ rule: null, questions: ["Still unsure?"] }));
    await handleIntakeReply(memory.db, job());
    expect(request()).toMatchObject({ clarify_stage: null, assignee_id: null, state: "submitted" });
    expect(memory.rows("intake_outbound")).toEqual([]);
  });
  it("queues the next round of preprocessing after an answer to its readiness check", async () => {
    setup({
      request: {
        state: "needs_information",
        assignee_id: sam,
        clarify_stage: "readiness",
        clarify_rounds: 1,
        clarify_preprocess: { with: { kind: "playbook", id: "pb-1" }, condition: "Customer contracts" },
      },
    });
    await handleIntakeReply(memory.db, job());
    expect(mocks.completeText).not.toHaveBeenCalled();
    // Still waiting until that round decides.
    expect(request()).toMatchObject({ state: "needs_information", clarify_stage: "readiness" });
    expect(queued("intake.preprocess")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ with: { kind: "playbook", id: "pb-1" }, round: 1 }),
      }),
    ]);
  });
  it("records an email reply, threading later ones on it", async () => {
    setup({
      source: "gmail",
      linkAddress: { provider: "gmail", mailbox: "intake@firm.test", to: ["jane@acme.test"], cc: [], reply_to_message_id: "old", thread: "t1" },
      request: { assignee_id: sam },
      payload: {
        kind: "mail_reply",
        provider: "gmail",
        mailbox: "intake@firm.test",
        provider_id: "gm-2",
        message_id: "reply-2@mail.acme.test",
        thread: "t1",
        from: { name: "Jane Business", email: "jane@acme.test" },
        to: ["intake@firm.test"],
        cc: [],
        subject: "Re: NDA",
        date: "2026-11-02T10:00:00.000Z",
        text: "Supplier.",
        attachments: [{ name: "schedule.pdf", file_type: "pdf", size: 3, key: `intake-inbound/${org}/${inboundId}/0` }],
        skipped: [{ name: "logo.png", reason: "type" }],
        references: ["first@mail.acme.test"],
      },
    });
    await handleIntakeReply(memory.db, job());
    expect(memory.rows("intake_messages")[0]).toMatchObject({
      kind: "reply",
      body: "Supplier.\n\nNot attached:\n- logo.png: not a PDF, Word, Excel or PowerPoint file",
      external_author: { name: "Jane Business", email: "jane@acme.test", source: "gmail" },
    });
    expect(memory.rows("intake_email_message_ids")).toEqual([
      expect.objectContaining({ link_id: "link-1", message_id: "reply-2@mail.acme.test" }),
    ]);
    expect(memory.rows("intake_channel_links")[0]!.address).toMatchObject({ reply_to_message_id: "gm-2" });
    // The staged copy is released once the reply is handled.
    expect(queued("storage.cleanup")).toEqual([
      expect.objectContaining({ payload: { keys: [`intake-inbound/${org}/${inboundId}/0`], prefixes: [] } }),
    ]);
  });
  it("settles a reply whose request was deleted, or whose message was, without content", async () => {
    setup({});
    memory.rows("intake_inbound")[0]!.request_id = null;
    await expect(handleIntakeReply(memory.db, job())).resolves.toEqual({ skipped: "request_gone" });
    expect(memory.rows("intake_inbound")[0]).toMatchObject({ status: "done", payload: null });
    setup({});
    stubSlack(null);
    await expect(handleIntakeReply(memory.db, job())).resolves.toEqual({ skipped: "message_gone" });
    expect(memory.rows("intake_messages")).toEqual([]);
  });
  it("says so, without content, when it fails for good", async () => {
    setup({});
    await markIntakeReplyFailed(memory.db, job());
    expect(memory.rows("intake_inbound")[0]).toMatchObject({
      status: "failed",
      payload: null,
      error: "MikeGC couldn't record a reply in the request's Slack thread.",
    });
  });
});
