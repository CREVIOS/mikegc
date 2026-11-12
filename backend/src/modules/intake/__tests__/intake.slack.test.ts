import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SlackApiError,
  compareSlackTs,
  downloadSlackFile,
  slackAuthTest,
  slackTextToPlain,
  slackThreadMessages,
  verifySlackSignature,
} from "../intake.slack";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const now = 1_700_000_000_000;
const timestamp = String(now / 1000);
const rawBody = Buffer.from('{"type":"event_callback","event":{"text":"hi"}}');
const sign = (body: Buffer, key = secret, ts = timestamp) =>
  "v0=" +
  createHmac("sha256", key).update(`v0:${ts}:`).update(body).digest("hex");

afterEach(() => vi.unstubAllGlobals());

describe("Slack request signatures", () => {
  const check = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]>) =>
    verifySlackSignature({
      secret,
      rawBody,
      timestamp,
      signature: sign(rawBody),
      nowMs: now,
      ...overrides,
    });
  it("accepts a request signed with the app's signing secret", () => {
    expect(check({})).toBe(true);
  });
  it("rejects another app's signature", () => {
    expect(check({ signature: sign(rawBody, "another-secret") })).toBe(false);
  });
  it("rejects a request older than five minutes, or from the future", () => {
    const stale = String(now / 1000 - 301);
    expect(check({ timestamp: stale, signature: sign(rawBody, secret, stale) })).toBe(false);
    const ahead = String(now / 1000 + 301);
    expect(check({ timestamp: ahead, signature: sign(rawBody, secret, ahead) })).toBe(false);
    const recent = String(now / 1000 - 299);
    expect(check({ timestamp: recent, signature: sign(rawBody, secret, recent) })).toBe(true);
  });
  it("rejects a body changed after signing", () => {
    expect(
      check({ rawBody: Buffer.from('{"type":"event_callback","event":{"text":"hj"}}') }),
    ).toBe(false);
  });
  it("rejects missing or malformed headers", () => {
    expect(check({ signature: undefined })).toBe(false);
    expect(check({ timestamp: undefined })).toBe(false);
    expect(check({ timestamp: "soon" })).toBe(false);
    expect(check({ signature: "v1=" + sign(rawBody).slice(3) })).toBe(false);
    expect(check({ signature: "v0=abc" })).toBe(false);
  });
});

describe("Slack markup as plain text", () => {
  const names = new Map([["U123", "Jane Business"]]);
  it("names people, drops Spectre's own mention and keeps links readable", () => {
    expect(
      slackTextToPlain(
        "<@UBOT> please ask <@U123> about <https://example.com/nda|the NDA> &amp; <mailto:jane@acme.test|jane@acme.test> in <#C1|legal> &lt;today&gt;",
        names,
        "UBOT",
      ),
    ).toBe(
      "please ask @Jane Business about the NDA (https://example.com/nda) & jane@acme.test in #legal <today>",
    );
  });
  it("falls back to Slack's own label, or a neutral name", () => {
    expect(slackTextToPlain("<@U999|sam> and <@U998>", names, null)).toBe(
      "@sam and @someone",
    );
    expect(slackTextToPlain("<!here> <!subteam^S1|@legal> <https://x.test>", names, null)).toBe(
      "@here @legal https://x.test",
    );
  });
});

describe("Slack Web API", () => {
  it("reads the workspace and bot user from auth.test with the token as a bearer", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { ok: true, team_id: "T1", team: "Acme", user_id: "UBOT" },
        { headers: { "x-oauth-scopes": "app_mentions:read,chat:write, files:write" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(slackAuthTest("xoxb-1")).resolves.toEqual({
      team_id: "T1",
      team: "Acme",
      user_id: "UBOT",
      // The token's scopes, which say whether the app can send documents.
      scopes: ["app_mentions:read", "chat:write", "files:write"],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/auth.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-1");
  });
  it("reports only Slack's error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" })));
    await expect(slackAuthTest("xoxb-1")).rejects.toMatchObject({ code: "invalid_auth" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, error: "Something <secret>" })),
    );
    await expect(slackAuthTest("xoxb-1")).rejects.toMatchObject({ code: "unknown_error" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(slackAuthTest("xoxb-1")).rejects.toBeInstanceOf(SlackApiError);
  });
  it("reads a thread up to the mention, oldest first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          messages: [
            { ts: "1700000000.000200", user: "U2", text: "second" },
            { ts: "1700000000.000100", user: "U1", text: "first" },
            { ts: "1700000000.000300", user: "U3", text: "after" },
          ],
        }),
      ),
    );
    const messages = await slackThreadMessages(
      "xoxb-1",
      "C1",
      "1700000000.000100",
      "1700000000.000200",
    );
    expect(messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(compareSlackTs("1700000000.0001", "1700000000.000099")).toBe(1);
  });
  it("sends the token only to Slack's file host and stops at the size limit", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(10)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadSlackFile("xoxb-1", "https://evil.test/f.pdf", 100),
    ).rejects.toMatchObject({ code: "invalid_file_url" });
    await expect(
      downloadSlackFile("xoxb-1", "http://files.slack.com/f.pdf", 100),
    ).rejects.toMatchObject({ code: "invalid_file_url" });
    expect(fetchMock).not.toHaveBeenCalled();
    const bytes = await downloadSlackFile("xoxb-1", "https://files.slack.com/f.pdf", 100);
    expect(bytes?.byteLength).toBe(10);
    expect(await downloadSlackFile("xoxb-1", "https://files.slack.com/f.pdf", 5)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })),
    );
    await expect(
      downloadSlackFile("xoxb-1", "https://files.slack.com/f.pdf", 100),
    ).rejects.toMatchObject({ code: "file_not_authorized" });
  });
});
