import { createHash, createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./memoryDb";

const mocks = vi.hoisted(() => ({
  memory: null as unknown as { db: unknown },
  uploadFile: vi.fn(),
  deleteFileBestEffort: vi.fn(),
  enqueueDbJob: vi.fn(),
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => mocks.memory.db,
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  uploadFile: mocks.uploadFile,
  deleteFileBestEffort: mocks.deleteFileBestEffort,
}));
vi.mock("../../../lib/dbq/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/dbq/enqueue")>()),
  enqueueDbJob: mocks.enqueueDbJob,
}));
// Small limits, so a test can exceed them without megabytes of base64.
vi.mock("../intake.inboundPayload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../intake.inboundPayload")>()),
  MAX_ATTACHMENT_BYTES: 64,
}));
vi.mock("../../user/user.service", () => ({
  getEffectiveApiKeys: vi.fn(),
  envApiKeys: vi.fn(() => ({})),
}));
import { encryptString } from "../../../lib/mcp/client";
import { intakeWebhooksRouter } from "../intake.webhooks.routes";

const org = "00000000-0000-4000-8000-000000000001";
const webhookId = "00000000-0000-4000-8000-0000000000aa";
const secret = "slack-signing-secret";
const token = "A".repeat(40) + "xyz";
const env = { ...process.env };
let memory: MemoryDb;
const app = express();
app.use("/webhooks/intake", intakeWebhooksRouter);
const inbound = () => memory.rows("intake_inbound");

function settings(overrides: Record<string, unknown> = {}) {
  const sealed = encryptString(secret);
  return {
    org_id: org,
    slack_webhook_id: webhookId,
    slack_enabled: true,
    slack_bot_user_id: "UBOT",
    slack_signing_secret_encrypted: sealed.encrypted,
    slack_signing_secret_iv: sealed.iv,
    slack_signing_secret_tag: sealed.tag,
    email_enabled: true,
    email_token_hash: createHash("sha256").update(token).digest("hex"),
    email_allowed_domains: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-encryption-secret-for-intake";
  memory = memoryDb({ intake_automation: [settings()] });
  mocks.memory = memory;
  mocks.enqueueDbJob.mockResolvedValue({ id: "job-1", deduped: false });
  mocks.uploadFile.mockResolvedValue(undefined);
});
afterAll(() => {
  process.env = env;
});

function slack(body: unknown, options: { secret?: string; ts?: number; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(body);
  const ts = String(options.ts ?? Math.floor(Date.now() / 1000));
  const signature =
    "v0=" +
    createHmac("sha256", options.secret ?? secret)
      .update(`v0:${ts}:${raw}`)
      .digest("hex");
  return request(app)
    .post(`/webhooks/intake/slack/${webhookId}`)
    .set("Content-Type", "application/json")
    .set("X-Slack-Request-Timestamp", ts)
    .set("X-Slack-Signature", signature)
    .send(raw);
}
const mention = (event: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T1",
  event: {
    type: "app_mention",
    user: "U123",
    text: "<@UBOT> please review the NDA",
    ts: "1762074840.000100",
    channel: "C42",
    ...event,
  },
});

describe("Slack events", () => {
  it("answers Slack's URL check once a signing secret is saved, before Slack is on", async () => {
    memory = memoryDb({ intake_automation: [settings({ slack_enabled: false })] });
    mocks.memory = memory;
    const res = await slack({ type: "url_verification", challenge: "3eZbrw1aBm" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "3eZbrw1aBm" });
  });
  it("refuses unsigned, mis-signed, stale and altered requests", async () => {
    const body = mention();
    expect((await slack(body, { secret: "wrong" })).status).toBe(403);
    expect((await slack(body, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(403);
    const signed = slack(body);
    // The same signature over a different body.
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature =
      "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
    const tampered = await request(app)
      .post(`/webhooks/intake/slack/${webhookId}`)
      .set("Content-Type", "application/json")
      .set("X-Slack-Request-Timestamp", ts)
      .set("X-Slack-Signature", signature)
      .send(raw.replace("review", "delete"));
    expect(tampered.status).toBe(403);
    expect(
      (await request(app).post(`/webhooks/intake/slack/${webhookId}`).send(raw)).status,
    ).toBe(403);
    expect((await signed).status).toBe(200);
    expect(inbound()).toHaveLength(1);
  });
  it("doesn't know an unknown URL or one without a signing secret", async () => {
    expect(
      (await request(app).post("/webhooks/intake/slack/not-a-uuid").send("{}")).status,
    ).toBe(404);
    memory = memoryDb({
      intake_automation: [settings({ slack_signing_secret_encrypted: null })],
    });
    mocks.memory = memory;
    expect((await slack({ type: "url_verification", challenge: "x" })).status).toBe(404);
  });
  it("stores a mention once and queues it, however often Slack delivers it", async () => {
    const res = await slack(mention({ files: [{ id: "F1", name: "nda.docx", size: 10, url_private_download: "https://files.slack.com/nda.docx" }] }));
    expect(res.status).toBe(200);
    expect(inbound()).toEqual([
      expect.objectContaining({
        org_id: org,
        source: "slack",
        external_id: "C42:1762074840.000100",
        status: "pending",
        payload: {
          kind: "slack",
          channel: "C42",
          ts: "1762074840.000100",
          thread_ts: null,
          user: "U123",
          text: "<@UBOT> please review the NDA",
          files: [{ id: "F1", name: "nda.docx", size: 10, url: "https://files.slack.com/nda.docx" }],
        },
      }),
    ]);
    const id = inbound()[0]!.id as string;
    expect(mocks.enqueueDbJob).toHaveBeenCalledWith(memory.db, {
      kind: "intake.inbound",
      payload: { inboundId: id, orgId: org },
      dedupeKey: `intake.inbound:${id}`,
      maxAttempts: 4,
    });
    // Slack retries: nothing new is stored; a waiting message is queued again
    // (the queue drops it while one job is live).
    expect((await slack(mention())).status).toBe(200);
    expect(inbound()).toHaveLength(1);
    expect(mocks.enqueueDbJob).toHaveBeenCalledTimes(2);
    inbound()[0]!.status = "done";
    expect((await slack(mention())).status).toBe(200);
    expect(mocks.enqueueDbJob).toHaveBeenCalledTimes(2);
  });
  it("keeps the thread a mention was posted in", async () => {
    await slack(mention({ thread_ts: "1762074000.000001" }));
    expect(inbound()[0]!.payload).toMatchObject({ thread_ts: "1762074000.000001" });
  });
  it("ignores bots, MikeGC itself, other events and a turned-off Slack", async () => {
    for (const body of [
      mention({ bot_id: "B1" }),
      mention({ user: "UBOT" }),
      mention({ subtype: "bot_message" }),
      { type: "event_callback", event: { type: "message", user: "U1", ts: "1.1", channel: "C1" } },
    ])
      expect((await slack(body)).status).toBe(200);
    memory.rows("intake_automation")[0]!.slack_enabled = false;
    expect((await slack(mention())).status).toBe(200);
    expect(inbound()).toEqual([]);
    expect(mocks.enqueueDbJob).not.toHaveBeenCalled();
  });
  it("asks Slack to retry when the message can't be queued", async () => {
    mocks.enqueueDbJob.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await slack(mention())).status).toBe(500);
    expect((await slack(mention())).status).toBe(200);
    expect(inbound()).toHaveLength(1);
    expect(mocks.enqueueDbJob).toHaveBeenCalledTimes(2);
  });
});

const pdf = (bytes = 10) => Buffer.alloc(bytes, 1).toString("base64");
const email = (overrides: Record<string, unknown> = {}) => ({
  From: "jane@acme.test",
  FromName: "Jane Business",
  FromFull: { Email: "Jane@Acme.test", Name: "Jane Business", MailboxHash: "" },
  To: "legal-intake@example.com",
  Subject: "NDA with Supplier Co",
  MessageID: "postmark-1",
  Date: "Mon, 2 Nov 2026 09:14:00 +0000",
  TextBody: "Please review the attached NDA.",
  HtmlBody: "<p>Please review the attached NDA.</p>",
  StrippedTextReply: "",
  Headers: [{ Name: "Message-ID", Value: "<abc@mail.acme.test>" }],
  Attachments: [],
  ...overrides,
});
const postEmail = (body: unknown, path = token) =>
  request(app).post(`/webhooks/intake/email/${path}`).send(body as object);

describe("inbound email", () => {
  it("refuses an unknown token, a malformed one, or email turned off with 403, which ends Postmark's retries", async () => {
    expect((await postEmail(email(), "B".repeat(43))).status).toBe(403);
    expect((await postEmail(email(), "short")).status).toBe(403);
    memory.rows("intake_automation")[0]!.email_enabled = false;
    expect((await postEmail(email())).status).toBe(403);
    expect(inbound()).toEqual([]);
  });
  it("stores the message, staging accepted attachments and listing the rest", async () => {
    const attachments = [
      { Name: "nda.docx", Content: pdf(), ContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ContentLength: 10 },
      { Name: "photo.png", Content: pdf(), ContentType: "image/png", ContentLength: 10 },
      { Name: "logo.png", Content: pdf(), ContentType: "image/png", ContentLength: 10, ContentID: "logo@1" },
      { Name: "huge.pdf", Content: pdf(65), ContentType: "application/pdf", ContentLength: 65 },
      ...Array.from({ length: 10 }, (_, i) => ({ Name: `part-${i}.pdf`, Content: pdf(), ContentType: "application/pdf" })),
    ];
    const res = await postEmail(email({ Attachments: attachments }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "received" });
    const row = inbound()[0]!;
    expect(row).toMatchObject({
      source: "email",
      external_id: "<abc@mail.acme.test>",
      status: "pending",
    });
    const payload = row.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "email",
      from: { name: "Jane Business", email: "jane@acme.test" },
      subject: "NDA with Supplier Co",
      date: "2026-11-02T09:14:00.000Z",
      text: "Please review the attached NDA.",
      skipped: [
        { name: "photo.png", reason: "type" },
        { name: "huge.pdf", reason: "size" },
        { name: "part-9.pdf", reason: "count" },
      ],
    });
    const staged = payload.attachments as { name: string; key: string }[];
    expect(staged).toHaveLength(10);
    expect(staged[0]).toEqual({
      name: "nda.docx",
      file_type: "docx",
      size: 10,
      key: `intake-inbound/${org}/${row.id}/0`,
    });
    expect(mocks.uploadFile).toHaveBeenCalledTimes(10);
    expect(mocks.uploadFile.mock.calls[0]![0]).toBe(`intake-inbound/${org}/${row.id}/0`);
    expect(mocks.enqueueDbJob).toHaveBeenCalledTimes(1);
  });
  it("records a message delivered twice once, without staging it again", async () => {
    const body = email({ Attachments: [{ Name: "a.pdf", Content: pdf() }] });
    await postEmail(body);
    const again = await postEmail(body);
    expect(again.body).toEqual({ status: "duplicate" });
    expect(inbound()).toHaveLength(1);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
  });
  it("falls back to Postmark's ID and the HTML body", async () => {
    await postEmail(email({ Headers: [], TextBody: "", HtmlBody: "<p>Hello<br>Legal &amp; co</p>" }));
    expect(inbound()[0]).toMatchObject({
      external_id: "postmark-1",
      payload: { text: "Hello\nLegal & co" },
    });
  });
  it("records automatic replies and bulk mail as ignored, with no content", async () => {
    for (const [i, header] of [
      { Name: "Auto-Submitted", Value: "auto-replied" },
      { Name: "Precedence", Value: "bulk" },
      { Name: "X-Autoreply", Value: "yes" },
    ].entries()) {
      const res = await postEmail(email({ MessageID: `auto-${i}`, Headers: [header] }));
      expect(res.body).toEqual({ status: "ignored" });
    }
    expect(inbound().map((r) => [r.status, r.payload])).toEqual([
      ["ignored", null],
      ["ignored", null],
      ["ignored", null],
    ]);
    expect(inbound()[0]!.error).toMatch(/automatic reply/);
    // "no" means a person sent it.
    await postEmail(email({ MessageID: "human", Headers: [{ Name: "Auto-Submitted", Value: "no" }] }));
    expect(inbound()[3]).toMatchObject({ status: "pending" });
    expect(mocks.enqueueDbJob).toHaveBeenCalledTimes(1);
  });
  it("ignores senders outside the accepted domains, accepting their subdomains", async () => {
    memory.rows("intake_automation")[0]!.email_allowed_domains = ["example.com"];
    await postEmail(email({ Attachments: [{ Name: "a.pdf", Content: pdf() }] }));
    expect(inbound()[0]).toMatchObject({
      status: "ignored",
      payload: null,
      error: "The sender's domain, acme.test, isn't one of the accepted domains.",
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    await postEmail(email({ MessageID: "m2", Headers: [], FromFull: { Email: "sam@eu.example.com" } }));
    expect(inbound()[1]).toMatchObject({ status: "pending" });
  });
  it("rejects a body that isn't an email", async () => {
    expect((await postEmail([1, 2])).status).toBe(400);
    expect((await postEmail({ Subject: "no id" })).status).toBe(400);
  });
  it("keeps the URL's token out of error logs", async () => {
    mocks.memory = {
      db: {
        from: () => {
          throw new Error("database unavailable");
        },
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await postEmail(email());
    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls.map((c) => c.map(String)))).not.toContain(token);
    expect(JSON.stringify(logged.mock.calls[0]?.[1] ?? {})).toContain(":token");
  });
});
