import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { automatedIntakeRpc, memoryDb, type MemoryDb } from "./memoryDb";

const mocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  getEffectiveApiKeys: vi.fn(),
  envApiKeys: vi.fn(),
  createDocumentVersion: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFileBestEffort: vi.fn(),
  enqueueDbJob: vi.fn(),
  enqueueStorageCleanup: vi.fn(),
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
  deleteFileBestEffort: mocks.deleteFileBestEffort,
}));
vi.mock("../../../lib/dbq/enqueue", () => ({
  enqueueDbJob: mocks.enqueueDbJob,
  enqueueStorageCleanup: mocks.enqueueStorageCleanup,
}));
vi.mock("../../../lib/queue/conversionQueue", () => ({
  enqueueConversion: mocks.enqueueConversion,
}));
import { NonRetryableJobError } from "../../../lib/dbq/runner";
import type { DbJob } from "../../../lib/dbq/types";
import { encryptString } from "../../../lib/mcp/client";
import {
  dispatchIntakeInbound,
  handleIntakeInbound,
  markIntakeInboundFailed,
} from "../intake.automationJob";
import { purgeIntake } from "../intake.lifecycle";

const org = "00000000-0000-4000-8000-000000000001";
const owner = "00000000-0000-4000-8000-000000000002";
const sam = "00000000-0000-4000-8000-000000000003";
const pat = "00000000-0000-4000-8000-000000000004";
const outsider = "00000000-0000-4000-8000-000000000009";
const inboundId = "00000000-0000-4000-8000-0000000000e1";
const env = { ...process.env };
let memory: MemoryDb;
let slackCalls: { method: string; params: Record<string, string> }[];
let slackReplies: Record<string, unknown>;

const job = (): DbJob => ({
  id: "job-1",
  kind: "intake.inbound",
  payload: { inboundId, orgId: org },
  status: "running",
  attempts: 1,
  max_attempts: 4,
  run_at: "",
  claimed_at: "",
  finished_at: null,
  last_error: null,
  dedupe_key: `intake.inbound:${inboundId}`,
  result: null,
  created_at: "",
});
const row = () => memory.rows("intake_inbound")[0]!;
const emailPayload = () => ({
  kind: "email",
  from: { name: "Jane Business", email: "jane@acme.test" },
  subject: "NDA with Supplier Co",
  date: "2026-11-02T09:14:00.000Z",
  text: "Please review the attached NDA by Friday.",
  attachments: [
    { name: "nda.docx", file_type: "docx", size: 4, key: `intake-inbound/${org}/${inboundId}/0` },
    { name: "logo.pdf", file_type: "pdf", size: 4, key: `intake-inbound/${org}/${inboundId}/1` },
  ],
  skipped: [{ name: "photo.png", reason: "type" }],
});
const slackPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: "slack",
  channel: "C42",
  ts: "1793610900.000300",
  thread_ts: "1793610840.000100",
  user: "U2",
  text: "<@UBOT> can Legal look at this?",
  files: [],
  ...overrides,
});

function setup(options: {
  payload: Record<string, unknown>;
  source?: "email" | "slack";
  triage?: boolean;
  kind?: "team" | "personal";
}) {
  const token = encryptString("xoxb-bot-token");
  memory = memoryDb(
    {
      organizations: [{ id: org, kind: options.kind ?? "team" }],
      org_members: [
        { org_id: org, user_id: owner, role: "owner" },
        { org_id: org, user_id: sam, role: "member" },
        { org_id: org, user_id: pat, role: "member" },
      ],
      user_profiles: [
        { user_id: owner, display_name: "Olive Owner", email: "olive@firm.test", account_deletion_requested_at: null },
        { user_id: sam, display_name: "Sam Lawyer", email: "sam@firm.test", account_deletion_requested_at: null },
        { user_id: pat, display_name: "Pat Counsel", email: "pat@firm.test", account_deletion_requested_at: null },
      ],
      intake_member_focus: [{ org_id: org, user_id: sam, focus: "NDAs" }],
      intake_automation: [
        {
          org_id: org,
          email_enabled: true,
          slack_enabled: true,
          slack_bot_user_id: "UBOT",
          slack_bot_token_encrypted: token.encrypted,
          slack_bot_token_iv: token.iv,
          slack_bot_token_tag: token.tag,
          triage_enabled: options.triage ?? true,
          default_timezone: "Europe/London",
          configured_by: owner,
        },
      ],
      intake_inbound: [
        {
          id: inboundId,
          org_id: org,
          source: options.source ?? "email",
          external_id: "message-1",
          payload: options.payload,
        },
      ],
      intake_requests: [],
      documents: [],
      intake_request_documents: [],
    },
    automatedIntakeRpc,
  );
}

function stubSlack(overrides: Record<string, (params: Record<string, string>) => unknown> = {}) {
  slackCalls = [];
  slackReplies = {};
  const people: Record<string, unknown> = {
    U1: { real_name: "Jane Business", profile: { real_name: "Jane Business", email: "jane@acme.test" } },
    U2: { real_name: "Ravi Sales", profile: { real_name: "Ravi Sales", email: "ravi@acme.test" } },
  };
  const methods: Record<string, (params: Record<string, string>) => unknown> = {
    "users.info": (p) =>
      people[p.user!] ? { ok: true, user: people[p.user!] } : { ok: false, error: "user_not_found" },
    "conversations.replies": () => ({
      ok: true,
      messages: [
        {
          ts: "1793610840.000100",
          user: "U1",
          text: "Need the Supplier Co NDA signed off\nThey want it back by Friday.",
          files: [
            { id: "F1", name: "Supplier NDA.pdf", size: 4, url_private_download: "https://files.slack.com/F1/nda.pdf" },
            { id: "F2", name: "notes.txt", size: 4, url_private_download: "https://files.slack.com/F2/notes.txt" },
          ],
        },
        { ts: "1793610860.000200", user: "UBOT", text: "an earlier MikeGC reply" },
        { ts: "1793610900.000300", user: "U2", text: "<@UBOT> can Legal look at this?" },
      ],
    }),
    "chat.postMessage": (p) => {
      slackReplies = p;
      return { ok: true };
    },
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://files.slack.com/"))
        return new Response(new Uint8Array([37, 80, 68, 70]));
      const method = target.replace("https://slack.com/api/", "");
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      slackCalls.push({ method, params });
      return Response.json(methods[method]?.(params) ?? { ok: false, error: "unknown_method" });
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-encryption-secret-for-intake";
  process.env.FRONTEND_URL = "https://mike.example.com/";
  delete process.env.DB_JOBS_ENABLED;
  mocks.envApiKeys.mockReturnValue({});
  mocks.getEffectiveApiKeys.mockResolvedValue({ claude: "sk-org" });
  mocks.createDocumentVersion.mockImplementation(async (_db, version) => ({
    data: { id: version.id },
    error: null,
  }));
  mocks.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
  mocks.uploadFile.mockResolvedValue(undefined);
  mocks.enqueueConversion.mockResolvedValue(undefined);
  mocks.enqueueStorageCleanup.mockResolvedValue(undefined);
  mocks.completeText.mockResolvedValue(
    JSON.stringify({
      subject: "Review Supplier Co NDA",
      summary: "Jane needs the Supplier Co NDA reviewed by Friday.",
      requester_name: "Jane Business",
      requester_email: "jane@acme.test",
      target_date: "2026-11-06",
      assignee_id: sam,
      attachments: [1],
    }),
  );
  stubSlack();
});
afterAll(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("recording an email", () => {
  it("records MikeGC's triaged request with the relevant documents, then forgets the message", async () => {
    setup({ payload: emailPayload() });
    await expect(handleIntakeInbound(memory.db, job())).resolves.toEqual({
      request_id: inboundId,
      triaged: true,
    });
    expect(memory.rpcCalls.find((c) => c.name === "intake_submit_automated")?.args).toMatchObject({
      p_org: org,
      p_inbound: inboundId,
      p_request: inboundId,
      p_subject: "Review Supplier Co NDA",
      p_requester_name: "Jane Business",
      p_requester_email: "jane@acme.test",
      p_date: "2026-11-06",
      p_timezone: "Europe/London",
      p_assignee: sam,
    });
    const [request] = memory.rows("intake_requests");
    expect(request).toMatchObject({ created_by: null, source: "email", assignee_id: sam });
    expect(request!.description).toMatch(/^Jane needs the Supplier Co NDA reviewed by Friday\.\n\n--- Original message ---/);
    // Triage kept the NDA and left out the logo.
    const documents = memory.rows("documents");
    expect(documents).toEqual([
      expect.objectContaining({
        user_id: null,
        org_id: org,
        library_kind: "intake_attachment",
        status: "ready",
      }),
    ]);
    const documentId = documents[0]!.id as string;
    expect(memory.rows("intake_request_documents")).toEqual([
      expect.objectContaining({ request_id: inboundId, document_id: documentId, automated: true }),
    ]);
    const key = `documents/intake-${org}/${documentId}/source.docx`;
    expect(mocks.downloadFile).toHaveBeenCalledWith(`intake-inbound/${org}/${inboundId}/0`);
    expect(mocks.uploadFile).toHaveBeenCalledWith(key, expect.any(ArrayBuffer), expect.stringContaining("wordprocessingml"));
    expect(mocks.createDocumentVersion).toHaveBeenCalledWith(memory.db, expect.objectContaining({
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: null,
      filename: "nda.docx",
      file_type: "docx",
      size_bytes: 4,
    }));
    // The viewer opens Word files from a PDF rendition, made as for uploads.
    expect(mocks.enqueueConversion).toHaveBeenCalledWith(expect.objectContaining({
      documentId,
      storagePath: key,
      fileType: "docx",
      pdfKey: `converted-pdfs/intake-${org}/${documentId}.pdf`,
      finalizeDocumentStatus: false,
    }));
    expect(row()).toMatchObject({ status: "done", payload: null, error: null, request_id: inboundId });
    expect(mocks.enqueueStorageCleanup).toHaveBeenCalledWith(memory.db, [
      `intake-inbound/${org}/${inboundId}/0`,
      `intake-inbound/${org}/${inboundId}/1`,
    ]);
    // The model saw the members and their focus, never another organization's.
    expect(mocks.completeText.mock.calls[0]![0].user).toContain('"handles":"NDAs"');
  });
  it("records the message as it is with triage off, keeping every attachment", async () => {
    setup({ payload: emailPayload(), triage: false });
    await expect(handleIntakeInbound(memory.db, job())).resolves.toMatchObject({ triaged: false });
    expect(mocks.completeText).not.toHaveBeenCalled();
    expect(memory.rows("intake_requests")[0]).toMatchObject({
      subject: "NDA with Supplier Co",
      requester_email: "jane@acme.test",
      assignee_id: null,
      requested_by_date: null,
    });
    expect(memory.rows("intake_requests")[0]!.description).toBe(
      "Please review the attached NDA by Friday.\n\n--- Not attached ---\n- photo.png: not a PDF, Word, Excel or PowerPoint file",
    );
    expect(memory.rows("documents")).toHaveLength(2);
  });
  it("leaves the request unassigned when the reviewer is no longer a member", async () => {
    setup({ payload: emailPayload() });
    mocks.completeText.mockResolvedValue(JSON.stringify({ assignee_id: outsider }));
    await handleIntakeInbound(memory.db, job());
    expect(memory.rows("intake_requests")[0]).toMatchObject({ assignee_id: null, state: "submitted" });
  });
  it("resumes after a failure without asking the model again or duplicating documents", async () => {
    setup({ payload: emailPayload(), triage: false });
    mocks.createDocumentVersion.mockRejectedValueOnce(new Error("storage hiccup"));
    await expect(handleIntakeInbound(memory.db, job())).rejects.toThrow("storage hiccup");
    expect(row()).toMatchObject({
      status: "pending",
      request_id: inboundId,
      error: "MikeGC couldn't record this message. Try sending it again.",
    });
    const planned = (row().payload as { documents: Record<string, { document_id: string; done: boolean }> }).documents;
    expect(planned["0"]).toMatchObject({ done: false });
    // The half-made document was rolled back.
    expect(memory.rows("documents")).toEqual([]);
    expect(mocks.deleteFileBestEffort).toHaveBeenCalled();

    await handleIntakeInbound(memory.db, job());
    expect(memory.rows("intake_requests")).toHaveLength(1);
    // The retried document kept the id it was given before it failed.
    expect(memory.rows("documents").map((d) => d.id)).toContain(planned["0"]!.document_id);
    expect(memory.rows("documents")).toHaveLength(2);
    expect(memory.rows("intake_request_documents")).toHaveLength(2);
    expect(row()).toMatchObject({ status: "done", error: null });
    // A third run finds nothing to do.
    await expect(handleIntakeInbound(memory.db, job())).resolves.toEqual({ skipped: "done" });
  });
  it("skips a message that is gone or already handled", async () => {
    setup({ payload: emailPayload() });
    memory.tables.intake_inbound = [];
    await expect(handleIntakeInbound(memory.db, job())).resolves.toEqual({ skipped: "missing" });
    await expect(
      handleIntakeInbound(memory.db, { ...job(), payload: { inboundId: "x" } }),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
  });
});

describe("recording a Slack thread", () => {
  it("records the thread up to the mention, with its first author as requester, and replies once", async () => {
    setup({ payload: slackPayload(), source: "slack", triage: false });
    await handleIntakeInbound(memory.db, job());
    expect(slackCalls.find((c) => c.method === "conversations.replies")?.params).toMatchObject({
      channel: "C42",
      ts: "1793610840.000100",
      latest: "1793610900.000300",
      inclusive: "true",
    });
    const [request] = memory.rows("intake_requests");
    expect(request).toMatchObject({
      source: "slack",
      subject: "Need the Supplier Co NDA signed off",
      requester_name: "Jane Business",
      requester_email: "jane@acme.test",
    });
    expect(request!.description).toBe(
      "Jane Business, 2 Nov 2026, 09:14 (Europe/London):\nNeed the Supplier Co NDA signed off\nThey want it back by Friday.\n\n" +
        "Ravi Sales, 2 Nov 2026, 09:15 (Europe/London):\ncan Legal look at this?\n\n" +
        "--- Not attached ---\n- notes.txt: not a PDF, Word, Excel or PowerPoint file",
    );
    expect(memory.rows("documents")).toHaveLength(1);
    expect(mocks.uploadFile.mock.calls[0]![0]).toMatch(/source\.pdf$/);
    expect(mocks.createDocumentVersion.mock.calls[0]![1]).toMatchObject({
      file_type: "pdf",
      pdf_storage_path: mocks.uploadFile.mock.calls[0]![0],
    });
    expect(mocks.enqueueConversion).not.toHaveBeenCalled();
    expect(slackReplies).toMatchObject({
      channel: "C42",
      thread_ts: "1793610840.000100",
      text: `Logged for Legal: <https://mike.example.com/intake/${inboundId}?org=${org}|Need the Supplier Co NDA signed off>. Not assigned to a reviewer yet.`,
    });
    expect(row()).toMatchObject({ status: "done", payload: null });
  });
  it("names the reviewer, and links Personal requests as personal", async () => {
    setup({ payload: slackPayload({ thread_ts: null, ts: "1793610840.000100", user: "U1", text: "<@UBOT> NDA please" }), source: "slack", kind: "personal" });
    await handleIntakeInbound(memory.db, job());
    expect(slackCalls.some((c) => c.method === "conversations.replies")).toBe(false);
    expect(slackReplies.thread_ts).toBe("1793610840.000100");
    expect(slackReplies.text).toBe(
      `Logged for Legal: <https://mike.example.com/intake/${inboundId}?org=personal|Review Supplier Co NDA>. Assigned to Sam Lawyer.`,
    );
  });
  it("never replies twice when a retry follows a sent reply", async () => {
    setup({ payload: slackPayload(), source: "slack", triage: false });
    let failDone = true;
    memory.intercept = ({ table, values }) => {
      if (table === "intake_inbound" && (values as { status?: string })?.status === "done" && failDone) {
        failDone = false;
        return { code: "08006", message: "connection lost" };
      }
      return undefined;
    };
    await expect(handleIntakeInbound(memory.db, job())).rejects.toMatchObject({ code: "08006" });
    expect(slackCalls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    await handleIntakeInbound(memory.db, job());
    expect(slackCalls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(memory.rows("documents")).toHaveLength(1);
    expect(row()).toMatchObject({ status: "done" });
  });
  it("fails at once, with a reason an admin can act on, when MikeGC can't read the channel", async () => {
    setup({ payload: slackPayload(), source: "slack" });
    stubSlack({ "conversations.replies": () => ({ ok: false, error: "not_in_channel" }) });
    await expect(handleIntakeInbound(memory.db, job())).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(row()).toMatchObject({
      status: "pending",
      error: "MikeGC can't read that Slack channel. Invite @MikeGC to it.",
    });
  });
});

describe("when a message fails for good", () => {
  it("marks it failed with its reason, drops its content and says so in Slack", async () => {
    setup({ payload: slackPayload(), source: "slack" });
    memory.rows("intake_inbound")[0]!.error = "MikeGC can't read that Slack channel. Invite @MikeGC to it.";
    await markIntakeInboundFailed(memory.db, job());
    expect(row()).toMatchObject({
      status: "failed",
      payload: null,
      error: "MikeGC can't read that Slack channel. Invite @MikeGC to it.",
    });
    expect(slackReplies).toMatchObject({
      thread_ts: "1793610840.000100",
      text: "Sorry, I couldn't log this for Legal. Please try again, or contact the Legal team directly.",
    });
    // Already settled: a second call changes nothing.
    await markIntakeInboundFailed(memory.db, job());
    expect(slackCalls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
  it("points the thread at a request that was recorded", async () => {
    setup({ payload: slackPayload(), source: "slack", triage: false });
    stubSlack({ "chat.postMessage": () => ({ ok: false, error: "ratelimited" }) });
    await expect(handleIntakeInbound(memory.db, job())).rejects.toBeTruthy();
    stubSlack();
    await markIntakeInboundFailed(memory.db, job());
    expect(row()).toMatchObject({
      status: "failed",
      request_id: inboundId,
      error: "The request was recorded, but MikeGC couldn't add all of its documents or reply in Slack.",
    });
    expect(String(slackReplies.text)).toMatch(/^Logged for Legal: </);
  });
  it("releases an email's staged attachments", async () => {
    setup({ payload: emailPayload() });
    await markIntakeInboundFailed(memory.db, job());
    expect(row()).toMatchObject({
      status: "failed",
      error: "MikeGC couldn't record this message. Try sending it again.",
    });
    expect(mocks.enqueueStorageCleanup).toHaveBeenCalledWith(memory.db, [
      `intake-inbound/${org}/${inboundId}/0`,
      `intake-inbound/${org}/${inboundId}/1`,
    ]);
  });
});

describe("queueing", () => {
  it("queues one live job per message", async () => {
    setup({ payload: emailPayload() });
    await dispatchIntakeInbound(memory.db, org, inboundId);
    expect(mocks.enqueueDbJob).toHaveBeenCalledWith(memory.db, {
      kind: "intake.inbound",
      payload: { inboundId, orgId: org },
      dedupeKey: `intake.inbound:${inboundId}`,
      maxAttempts: 4,
    });
  });
  it("runs it in-process when the job runner is off", async () => {
    process.env.DB_JOBS_ENABLED = "false";
    setup({ payload: emailPayload(), triage: false });
    await dispatchIntakeInbound(memory.db, org, inboundId);
    expect(mocks.enqueueDbJob).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(row().status).toBe("done"));
  });
});

describe("purging intake", () => {
  // The intake_inbound delete trigger hands staged files to the storage
  // worker (see intake.postgres.test.ts), so the purge itself is one call.
  it("purges through the owner-authorized transaction alone", async () => {
    setup({ payload: emailPayload() });
    const purge = vi.fn(() => ({ data: null, error: null }));
    const db = memoryDb(memory.tables, { intake_purge: purge });
    await purgeIntake(db.db, org, owner);
    expect(purge).toHaveBeenCalledWith({ p_org: org, p_actor: owner }, expect.anything());
    expect(mocks.enqueueStorageCleanup).not.toHaveBeenCalled();
  });
  it("fails when the owner check refuses the purge", async () => {
    setup({ payload: emailPayload() });
    const db = memoryDb(memory.tables, {
      intake_purge: () => ({ data: null, error: { code: "42501" } }),
    });
    await expect(purgeIntake(db.db, org, sam)).rejects.toThrow();
  });
});
