import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./memoryDb";

const mocks = vi.hoisted(() => ({
  memory: null as unknown as { db: unknown },
  getEffectiveApiKeys: vi.fn(),
  envApiKeys: vi.fn(),
  userId: "",
}));
vi.mock("../../user/user.service", () => ({
  getEffectiveApiKeys: mocks.getEffectiveApiKeys,
  envApiKeys: mocks.envApiKeys,
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => mocks.memory.db,
}));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.locals.userId = mocks.userId;
    next();
  },
}));
import {
  generateIntakeEmailWebhook,
  getIntakeAutomation,
  normalizeDomains,
  slackBotToken,
  slackSigningSecret,
  updateIntakeAutomation,
  type AutomationRow,
} from "../intake.automation";
import { intakeRouter } from "../intake.routes";

const org = "00000000-0000-4000-8000-000000000001";
const owner = "00000000-0000-4000-8000-000000000002";
const admin = "00000000-0000-4000-8000-000000000003";
const member = "00000000-0000-4000-8000-000000000004";
const outsider = "00000000-0000-4000-8000-000000000005";
const env = { ...process.env };
let memory: MemoryDb;
const scope = (actorId: string) => ({ orgId: org, actorId });
const row = () => memory.rows("intake_automation")[0] as AutomationRow;
const app = express();
app.use(express.json());
app.use("/intake", intakeRouter);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-encryption-secret-for-intake";
  process.env.API_PUBLIC_URL = "https://app.example.com/api/";
  mocks.envApiKeys.mockReturnValue({});
  mocks.getEffectiveApiKeys.mockResolvedValue({ claude: "sk-org" });
  memory = memoryDb({
    org_members: [
      { org_id: org, user_id: owner, role: "owner" },
      { org_id: org, user_id: admin, role: "admin" },
      { org_id: org, user_id: member, role: "member" },
    ],
  });
  mocks.memory = memory;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ok: true, team_id: "T1", team: "Acme", user_id: "UBOT" }),
    ),
  );
});
afterAll(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("who manages automated intake", () => {
  it.each([member, outsider])("refuses %s, who isn't an owner or admin", async (actor) => {
    for (const result of [
      await getIntakeAutomation(memory.db, scope(actor)),
      await updateIntakeAutomation(memory.db, scope(actor), { triage_enabled: false }),
      await generateIntakeEmailWebhook(memory.db, scope(actor)),
    ])
      expect(result).toMatchObject({ ok: false, kind: "forbidden" });
    expect(memory.rows("intake_automation")).toEqual([]);
  });
  it("shows an admin the settings, made on first read with the Slack events URL", async () => {
    const result = await getIntakeAutomation(memory.db, scope(admin));
    expect(result).toEqual({
      ok: true,
      data: {
        email: { enabled: false, configured: false, token_hint: null, allowed_domains: [] },
        slack: {
          enabled: false,
          events_url: `https://app.example.com/api/webhooks/intake/slack/${row().slack_webhook_id}`,
          configured: false,
          team_id: null,
          team_name: null,
          bot_user_id: null,
        },
        triage: { enabled: true, default_timezone: null, model_available: true },
        focus: [],
        recent: [],
      },
    });
    // Nobody has saved yet: the viewer is who triage would run as.
    expect(mocks.getEffectiveApiKeys).toHaveBeenCalledWith(admin, org, memory.db);
  });
  it("says when no model is available", async () => {
    mocks.getEffectiveApiKeys.mockResolvedValue({});
    const result = await getIntakeAutomation(memory.db, scope(owner));
    expect(result.ok && result.data.triage.model_available).toBe(false);
  });
  it("lists the 20 most recent messages without their content", async () => {
    memory.tables.intake_inbound = Array.from({ length: 22 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
      org_id: org,
      source: i % 2 ? "slack" : "email",
      external_id: `m-${i}`,
      status: "done",
      payload: { text: "secret" },
      request_id: null,
      error: null,
      created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    }));
    const result = await getIntakeAutomation(memory.db, scope(owner));
    if (!result.ok) throw new Error("expected settings");
    expect(result.data.recent).toHaveLength(20);
    expect(result.data.recent[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000121",
      source: "slack",
      status: "done",
      error: null,
      request_id: null,
      created_at: new Date(Date.UTC(2026, 10, 1, 0, 21)).toISOString(),
    });
    expect(JSON.stringify(result.data)).not.toContain("secret");
  });
});

describe("saving Slack's credentials", () => {
  it("encrypts both secrets, checks the token with Slack and never returns them", async () => {
    const result = await updateIntakeAutomation(memory.db, scope(admin), {
      slack_signing_secret: " signing-secret-1 ",
      slack_bot_token: "xoxb-123-abc",
      slack_enabled: true,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        slack: {
          enabled: true,
          configured: true,
          team_id: "T1",
          team_name: "Acme",
          bot_user_id: "UBOT",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/signing-secret-1|xoxb-123-abc/);
    expect(JSON.stringify(memory.tables)).not.toMatch(/signing-secret-1|xoxb-123-abc/);
    expect(slackSigningSecret(row())).toBe("signing-secret-1");
    expect(slackBotToken(row())).toBe("xoxb-123-abc");
    expect(row().configured_by).toBe(admin);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/auth.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-123-abc");
  });
  it("rejects a token Slack refuses, saving nothing", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ok: false, error: "invalid_auth" }));
    const result = await updateIntakeAutomation(memory.db, scope(owner), {
      slack_bot_token: "xoxb-revoked",
      triage_enabled: false,
    });
    expect(result).toMatchObject({ ok: false, kind: "validation", code: "slack_token_invalid" });
    expect(row()).toMatchObject({ triage_enabled: true, slack_bot_token_encrypted: null });
  });
  it("says so when Slack can't be reached", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), { slack_bot_token: "xoxb-1" }),
    ).toMatchObject({ ok: false, kind: "unavailable" });
  });
  it("won't turn a channel on before it is set up", async () => {
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), { slack_enabled: true }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), { email_enabled: true }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(row()).toMatchObject({ slack_enabled: false, email_enabled: false });
  });
  it("can't save secrets without the server's encryption secret", async () => {
    delete process.env.MCP_CONNECTORS_ENCRYPTION_SECRET;
    delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), { slack_signing_secret: "s" }),
    ).toMatchObject({ ok: false, kind: "unavailable" });
  });
});

describe("the email webhook URL", () => {
  it("is a fresh secret token, kept only as its hash, and replaces the last one", async () => {
    const first = await generateIntakeEmailWebhook(memory.db, scope(owner));
    if (!first.ok) throw new Error("expected a URL");
    const token = first.data.webhook_url.split("/").pop()!;
    expect(first.data.webhook_url).toBe(
      `https://app.example.com/api/webhooks/intake/email/${token}`,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.data.token_hint).toBe(token.slice(-4));
    expect(row()).toMatchObject({
      email_token_hash: createHash("sha256").update(token).digest("hex"),
      email_token_hint: token.slice(-4),
      configured_by: owner,
    });
    expect(JSON.stringify(memory.tables)).not.toContain(token);
    const second = await generateIntakeEmailWebhook(memory.db, scope(owner));
    expect(second.ok && second.data.webhook_url).not.toBe(first.data.webhook_url);
    const settings = await updateIntakeAutomation(memory.db, scope(owner), {
      email_enabled: true,
    });
    expect(settings).toMatchObject({
      ok: true,
      data: { email: { enabled: true, configured: true } },
    });
  });
});

describe("other settings", () => {
  it("normalizes sender domains", () => {
    expect(normalizeDomains(["@Example.COM", "example.com", " sub.acme.test ", ""])).toEqual({
      ok: true,
      data: ["example.com", "sub.acme.test"],
    });
    for (const bad of ["not a domain", "localhost", "a@b.com", "-x.com"])
      expect(normalizeDomains([bad]), bad).toMatchObject({ ok: false, kind: "validation" });
  });
  it("saves domains, the timezone and triage, rejecting an unknown timezone", async () => {
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), { default_timezone: "Mars/Olympus" }),
    ).toMatchObject({ ok: false, kind: "validation" });
    const saved = await updateIntakeAutomation(memory.db, scope(owner), {
      email_allowed_domains: ["Acme.test"],
      default_timezone: "Europe/London",
      triage_enabled: false,
    });
    expect(saved).toMatchObject({
      ok: true,
      data: {
        email: { allowed_domains: ["acme.test"] },
        triage: { enabled: false, default_timezone: "Europe/London" },
      },
    });
  });
  it("replaces every member's focus, for members only", async () => {
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), {
        focus: [{ user_id: outsider, focus: "NDAs" }],
      }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(
      await updateIntakeAutomation(memory.db, scope(owner), {
        focus: [
          { user_id: member, focus: "NDAs" },
          { user_id: member, focus: "Again" },
        ],
      }),
    ).toMatchObject({ ok: false, kind: "validation" });
    await updateIntakeAutomation(memory.db, scope(owner), {
      focus: [
        { user_id: member, focus: " NDAs and procurement " },
        { user_id: admin, focus: "Employment" },
      ],
    });
    const result = await updateIntakeAutomation(memory.db, scope(owner), {
      focus: [{ user_id: admin, focus: "Disputes" }],
    });
    expect(result.ok && result.data.focus).toEqual([{ user_id: admin, focus: "Disputes" }]);
    await updateIntakeAutomation(memory.db, scope(owner), { focus: [] });
    expect(memory.rows("intake_member_focus")).toEqual([]);
  });
});

describe("automation routes", () => {
  const path = `/intake/${org}/automation`;
  it("validates the body before the service and names what to fix", async () => {
    mocks.userId = owner;
    for (const [body, detail] of [
      [{ slack_bot_token: "xoxp-user-token" }, /xoxb-/],
      [{ slack_signing_secret: "x".repeat(301) }, /signing secret/],
      [{ default_timezone: "Nowhere/City" }, /timezone/],
      [{ focus: [{ user_id: member, focus: "" }] }, /1 to 500/],
      [{ email_allowed_domains: Array(51).fill("a.test") }, /50/],
      [{ unexpected: true }, /Check the automation settings/],
    ] as const) {
      const res = await request(app).patch(path).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.detail).toMatch(detail);
    }
    expect(memory.rows("intake_automation")).toEqual([]);
  });
  it("answers a member with 403 and an admin with the settings", async () => {
    mocks.userId = member;
    expect((await request(app).get(path)).status).toBe(403);
    expect((await request(app).post(`${path}/email-webhook`)).status).toBe(403);
    mocks.userId = admin;
    const res = await request(app).patch(path).send({ triage_enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.triage.enabled).toBe(false);
    const made = await request(app).post(`${path}/email-webhook`);
    expect(made.status).toBe(201);
    expect(made.body.webhook_url).toMatch(/\/webhooks\/intake\/email\/[A-Za-z0-9_-]{43}$/);
  });
});
