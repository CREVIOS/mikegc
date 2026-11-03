import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, requesterLoopRpc, type MemoryDb } from "./memoryDb";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  enqueueDbJob: vi.fn(),
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  uploadFile: mocks.uploadFile,
  downloadFile: mocks.downloadFile,
  deleteFileBestEffort: vi.fn(),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: mocks.enqueueDbJob }));
vi.mock("../../user/user.service", () => ({ getEffectiveApiKeys: vi.fn(), envApiKeys: vi.fn(() => ({})) }));
import type { DbJob } from "../../../lib/dbq/types";
import { DbJobDeferredError } from "../../../lib/dbq/types";
import { encryptString } from "../../../lib/mcp/client";
import { handleIntakeDeliver } from "../intake.deliver";
import { handleIntakeMailboxPoll, recordMail } from "../intake.mailbox";
import { clearMicrosoftTokens } from "../intake.microsoft";
import type { ReadMail } from "../intake.outlook";
import type { AutomationRow } from "../intake.settingsRow";

const org = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000021";
const env = { ...process.env };
let memory: MemoryDb;

const passed = "mx.google.com; dkim=pass header.d=acme.test; spf=pass smtp.mailfrom=acme.test; dmarc=pass header.from=acme.test";
const mail = (overrides: Partial<ReadMail> = {}): ReadMail => ({
  provider: "gmail",
  providerId: "gm-1",
  internetMessageId: "<first@mail.acme.test>",
  thread: "t1",
  headers: [{ name: "Authentication-Results", value: passed }],
  from: { name: "Jane Business", email: "jane@acme.test" },
  to: ["intake@firm.test"],
  cc: ["ben@acme.test", "eve@elsewhere.test"],
  subject: "NDA with Supplier Co",
  date: "2026-11-02T09:14:00.000Z",
  text: "Please review the attached NDA.",
  newText: "Please review the attached NDA.",
  attachments: [],
  isDraft: false,
  ...overrides,
});
const settings = () => memory.rows("intake_automation")[0] as unknown as AutomationRow;
const inbound = () => memory.rows("intake_inbound");
const kinds = () => mocks.enqueueDbJob.mock.calls.map(([, input]) => input.kind);

beforeEach(() => {
  vi.clearAllMocks();
  clearMicrosoftTokens();
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-encryption-secret-for-intake";
  process.env.DB_JOBS_ENABLED = "true";
  mocks.enqueueDbJob.mockResolvedValue({ id: "job-1", deduped: false });
  mocks.uploadFile.mockResolvedValue(undefined);
  const secret = encryptString("graph-secret");
  memory = memoryDb(
    {
      intake_automation: [
        {
          org_id: org,
          email_enabled: true,
          email_provider: "gmail",
          email_mailbox: "intake@firm.test",
          email_allowed_domains: ["acme.test"],
          graph_tenant_id: "tenant-1",
          graph_client_id: "client-1",
          graph_client_secret_encrypted: secret.encrypted,
          graph_client_secret_iv: secret.iv,
          graph_client_secret_tag: secret.tag,
        },
      ],
      intake_inbound: [],
      intake_channel_links: [],
      intake_email_message_ids: [],
    },
    requesterLoopRpc(),
  );
});
afterAll(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

const linkThread = (address: Record<string, unknown> = {}) => {
  memory.rows("intake_channel_links").push({
    id: "link-1",
    org_id: org,
    request_id: requestId,
    source: "gmail",
    thread_key: "gmail:t1",
    address: { provider: "gmail", mailbox: "intake@firm.test", to: ["jane@acme.test"], cc: ["ben@acme.test"], ...address },
  });
};

describe("recording email from the intake mailbox", () => {
  it("records a new email to the intake address once, as a request", async () => {
    expect(await recordMail(memory.db, settings(), mail())).toBe("received");
    expect(await recordMail(memory.db, settings(), mail())).toBe("duplicate");
    expect(inbound()).toEqual([
      expect.objectContaining({
        source: "gmail",
        kind: "request",
        external_id: "first@mail.acme.test",
        status: "pending",
        payload: expect.objectContaining({
          kind: "mail",
          provider: "gmail",
          provider_id: "gm-1",
          message_id: "first@mail.acme.test",
          thread: "t1",
          text: "Please review the attached NDA.",
          related_request_id: null,
        }),
      }),
    ]);
    expect(kinds()).toEqual(["intake.inbound"]);
  });
  it("ignores automatic mail, mail not to the intake address, other domains and an unauthenticated sender", async () => {
    const cases: [Partial<ReadMail>, RegExp][] = [
      [{ headers: [{ name: "Auto-Submitted", value: "auto-replied" }] }, /automatic reply/],
      [{ to: ["someone@firm.test"], cc: [] }, /wasn't addressed to the intake address/],
      [{ from: { name: "Eve", email: "eve@elsewhere.test" } }, /elsewhere\.test, isn't one of the accepted domains/],
      [{ headers: [{ name: "Authentication-Results", value: "mx.google.com; spf=fail; dmarc=fail header.from=acme.test" }] }, /didn't authenticate/],
    ];
    for (const [i, [overrides, reason]] of cases.entries()) {
      expect(await recordMail(memory.db, settings(), mail({ internetMessageId: `<m${i}@x>`, ...overrides }))).toBe("ignored");
      expect(inbound().at(-1)).toMatchObject({ status: "ignored", payload: null, error: expect.stringMatching(reason) });
    }
    // Mail the mailbox sent itself, and drafts, are skipped without a row.
    expect(await recordMail(memory.db, settings(), mail({ from: { name: "Legal", email: "intake@firm.test" } }))).toBe("skipped");
    expect(await recordMail(memory.db, settings(), mail({ isDraft: true }))).toBe("skipped");
    expect(inbound()).toHaveLength(4);
    expect(kinds()).toEqual([]);
  });
  it("records a reply in a request's thread, from someone on it, without the history it quotes", async () => {
    linkThread();
    const reply = mail({
      providerId: "gm-2",
      internetMessageId: "<reply@mail.acme.test>",
      from: { name: "Ben", email: "ben@acme.test" },
      text: "Supplier.\n\nOn Mon, 2 Nov 2026 at 09:14, Legal <intake@firm.test> wrote:\n> Is Acme a customer?",
    });
    expect(await recordMail(memory.db, settings(), reply)).toBe("received");
    expect(inbound()).toEqual([
      expect.objectContaining({
        kind: "reply",
        request_id: requestId,
        payload: expect.objectContaining({ kind: "mail_reply", text: "Supplier.", provider_id: "gm-2" }),
      }),
    ]);
    expect(kinds()).toEqual(["intake.reply"]);
  });
  it("matches a reply whose edited subject started a new conversation by the Message-ID it answers", async () => {
    linkThread();
    memory.rows("intake_email_message_ids").push({ org_id: org, link_id: "link-1", message_id: "ours@mikegc" });
    const reply = mail({
      thread: "t-new",
      internetMessageId: "<reply2@mail.acme.test>",
      headers: [
        { name: "Authentication-Results", value: passed },
        { name: "In-Reply-To", value: "<ours@mikegc>" },
      ],
    });
    expect(await recordMail(memory.db, settings(), reply)).toBe("received");
    expect(inbound()[0]).toMatchObject({ kind: "reply", request_id: requestId });
  });
  it("makes mail in a request's thread from someone not on it a new request, noted on the other", async () => {
    linkThread({ to: ["jane@acme.test"], cc: [] });
    memory.rows("intake_automation")[0]!.email_allowed_domains = ["acme.test", "partner.test"];
    const other = mail({
      providerId: "gm-3",
      internetMessageId: "<other@partner.test>",
      from: { name: "Pat", email: "pat@partner.test" },
      headers: [{ name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=partner.test" }],
    });
    expect(await recordMail(memory.db, settings(), other)).toBe("received");
    expect(inbound()[0]).toMatchObject({
      kind: "request",
      payload: expect.objectContaining({ kind: "mail", related_request_id: requestId }),
    });
  });
  it("doesn't count a forged sender on the thread as a reply", async () => {
    linkThread();
    const forged = mail({
      internetMessageId: "<forged@evil.test>",
      headers: [{ name: "Authentication-Results", value: "mx.google.com; spf=fail smtp.mailfrom=evil.test; dmarc=fail header.from=acme.test" }],
    });
    expect(await recordMail(memory.db, settings(), forged)).toBe("ignored");
    expect(inbound()[0]).toMatchObject({ status: "ignored", error: expect.stringMatching(/didn't authenticate/) });
  });
});

describe("reading the mailbox", () => {
  const poll = (payload: Record<string, unknown> = {}): DbJob => ({
    id: "job-1",
    kind: "intake.mailbox.poll",
    payload: { orgId: org, ...payload },
    status: "running",
    attempts: 1,
    max_attempts: 100,
    run_at: "",
    claimed_at: "",
    finished_at: null,
    last_error: null,
    dedupe_key: `intake.mailbox.poll:${org}`,
    result: null,
    created_at: "",
  });
  it("stops once email is switched off", async () => {
    memory.rows("intake_automation")[0]!.email_enabled = false;
    await expect(handleIntakeMailboxPoll(memory.db, poll())).resolves.toEqual({ stopped: true });
  });
  it("reads Outlook from its delta link and comes back in 15 minutes, keeping the subscription", async () => {
    Object.assign(memory.rows("intake_automation")[0]!, {
      email_provider: "graph",
      graph_subscription_id: "sub-1",
      graph_subscription_expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      graph_delta_link: "https://graph.microsoft.com/v1.0/delta?token=1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const target = String(url);
        if (target.startsWith("https://login.microsoftonline.com/"))
          return Response.json({ access_token: "h.e30.s", expires_in: 3600 });
        if (target === "https://graph.microsoft.com/v1.0/delta?token=1")
          return Response.json({ value: [{ id: "gone", "@removed": { reason: "deleted" } }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?token=2" });
        return Response.json({}, { status: 404 });
      }),
    );
    const before = Date.now();
    const result = handleIntakeMailboxPoll(memory.db, poll());
    await expect(result).rejects.toBeInstanceOf(DbJobDeferredError);
    const next = await result.catch((e: DbJobDeferredError) => Date.parse(e.runAt));
    expect(next).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(settings().graph_delta_link).toBe("https://graph.microsoft.com/v1.0/delta?token=2");
    expect(settings().email_last_read_at).toBeTruthy();
  });
  it("shows an admin why the mailbox can't be read, and keeps coming back", async () => {
    Object.assign(memory.rows("intake_automation")[0]!, { email_provider: "graph", graph_delta_link: "https://graph.microsoft.com/v1.0/d" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_client" }, { status: 401 })));
    await expect(handleIntakeMailboxPoll(memory.db, poll())).rejects.toBeInstanceOf(DbJobDeferredError);
    expect(settings().email_error).toMatch(/didn't accept the intake mailbox's app credentials/);
  });
});

describe("replying from Outlook", () => {
  it("replies to all on the newest message, attaches what fits and sends", async () => {
    Object.assign(memory.rows("intake_automation")[0]!, { email_provider: "graph" });
    memory.tables.intake_requests = [{ id: requestId, org_id: org, subject: "NDA", assignee_id: null }];
    memory.tables.intake_messages = [{ id: "m1", org_id: org, request_id: requestId, kind: "question", body: "Before Legal starts, MikeGC needs:\n1. Which entity is signing?" }];
    memory.rows("intake_channel_links").push({
      id: "link-1",
      org_id: org,
      request_id: requestId,
      source: "outlook",
      thread_key: "graph:conv-1",
      address: {
        provider: "graph",
        mailbox: "intake@firm.test",
        to: ["jane@acme.test"],
        cc: ["ben@acme.test", "intake@firm.test"],
        subject: "NDA",
        reply_to_message_id: "graph-msg-1",
        thread: "conv-1",
        max_attachment_bytes: 35 * 1024 * 1024,
      },
    });
    memory.tables.intake_outbound = [
      { id: "00000000-0000-4000-8000-0000000000f1", org_id: org, request_id: requestId, link_id: "link-1", message_id: "m1", author_id: null, kind: "question", documents: [], status: "pending", external_id: null, attempted_at: null },
    ];
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        const json = typeof init?.body === "string" && init.body.startsWith("{");
        calls.push({ url: target, method: init?.method ?? "GET", body: json ? JSON.parse(String(init!.body)) : null });
        if (target.startsWith("https://login.microsoftonline.com/"))
          return Response.json({ access_token: "h.e30.s", expires_in: 3600 });
        if (target.includes("mailFolders('drafts')")) return Response.json({ value: [] });
        if (target.endsWith("/createReplyAll"))
          return Response.json({ id: "draft-1", internetMessageId: "<draft-1@firm.test>" });
        if (target.endsWith("/send")) return new Response(null, { status: 202 });
        return Response.json({}, { status: 404 });
      }),
    );
    await handleIntakeDeliver(memory.db, {
      id: "job",
      kind: "intake.deliver",
      payload: { orgId: org, outboundId: "00000000-0000-4000-8000-0000000000f1" },
      status: "running",
      attempts: 1,
      max_attempts: 5,
      run_at: "",
      claimed_at: "",
      finished_at: null,
      last_error: null,
      dedupe_key: null,
      result: null,
      created_at: "",
    });
    const reply = calls.find((c) => c.url.endsWith("/messages/graph-msg-1/createReplyAll"))!;
    expect(reply.body).toMatchObject({
      message: {
        toRecipients: [{ emailAddress: { address: "jane@acme.test" } }],
        // Never the mailbox itself.
        ccRecipients: [{ emailAddress: { address: "ben@acme.test" } }],
        body: {
          contentType: "Text",
          content:
            "Before Legal starts, MikeGC needs:\n1. Which entity is signing?\n\nReply to this email to answer. Your reply goes to the Legal team's request.",
        },
        singleValueExtendedProperties: [
          { id: "String {00020329-0000-0000-C000-000000000046} Name MikeGCOutboundId", value: "00000000-0000-4000-8000-0000000000f1" },
        ],
        internetMessageHeaders: [{ name: "X-Auto-Submitted", value: "auto-generated" }],
      },
    });
    expect(calls.some((c) => c.url.endsWith("/messages/draft-1/send") && c.method === "POST")).toBe(true);
    expect(memory.rows("intake_outbound")[0]).toMatchObject({ status: "sent", external_id: "<draft-1@firm.test>" });
    // Later replies thread on the Message-ID MikeGC sent.
    expect(memory.rows("intake_email_message_ids")).toEqual([
      expect.objectContaining({ link_id: "link-1", message_id: "draft-1@firm.test" }),
    ]);
  });
});
