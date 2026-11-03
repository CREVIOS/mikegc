import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, requesterLoopRpc, type MemoryDb } from "./memoryDb";

const mocks = vi.hoisted(() => ({ downloadFile: vi.fn() }));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
}));
import { encryptString } from "../../../lib/mcp/client";
import { handleIntakeDeliver } from "../intake.deliver";
import { clearMicrosoftTokens } from "../intake.microsoft";
import { shareId, teamsActivity, teamsActivityText, teamsEscape } from "../intake.teams";

const org = "00000000-0000-4000-8000-000000000001";
const emma = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000021";
const outboundId = "00000000-0000-4000-8000-0000000000f1";
const appId = "11111111-1111-4111-8111-111111111111";
const env = { ...process.env };
let memory: MemoryDb;
let calls: { url: string; method: string; body: unknown }[];

function setup(filesAccess: boolean) {
  const secret = encryptString("teams-secret");
  memory = memoryDb(
    {
      user_profiles: [{ user_id: emma, display_name: "Emma Chen", email: "emma@firm.test" }],
      intake_automation: [
        {
          org_id: org,
          teams_enabled: true,
          teams_app_id: appId,
          teams_tenant_id: "tenant-1",
          teams_client_secret_encrypted: secret.encrypted,
          teams_client_secret_iv: secret.iv,
          teams_client_secret_tag: secret.tag,
          teams_files_access: filesAccess,
        },
      ],
      intake_requests: [{ id: requestId, org_id: org, subject: "Review: Acme NDA", assignee_id: emma }],
      intake_channel_links: [
        {
          id: "link-1",
          org_id: org,
          request_id: requestId,
          source: "teams",
          thread_key: "tenant-1:19:abc@thread.tacv2;messageid=1",
          address: {
            service_url: "https://smba.trafficmanager.net/emea/",
            tenant_id: "tenant-1",
            aad_group_id: "group-1",
            channel_id: "19:abc@thread.tacv2",
            conversation_id: "19:abc@thread.tacv2;messageid=1",
            root_message_id: "1",
            channel_name: "Legal requests",
          },
        },
      ],
      intake_messages: [{ id: "m1", org_id: org, request_id: requestId, kind: "resolution", body: "Approved *with* edits." }],
      document_versions: [{ id: "v0", filename: "nda.docx", file_type: "docx", size_bytes: 3, storage_path: "documents/x/nda.docx", deleted_at: null }],
      intake_outbound: [
        { id: outboundId, org_id: org, request_id: requestId, link_id: "link-1", message_id: "m1", author_id: emma, kind: "answer", documents: [{ document_id: "d0", version_id: "v0" }], status: "pending", external_id: null, attempted_at: null },
      ],
    },
    requesterLoopRpc(),
  );
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      const json = typeof init?.body === "string" && init.body.startsWith("{");
      calls.push({ url: target, method: init?.method ?? "GET", body: json ? JSON.parse(String(init!.body)) : null });
      if (target.startsWith("https://login.microsoftonline.com/"))
        return Response.json({ access_token: "h.e30.s", expires_in: 3600 });
      if (target.endsWith("/filesFolder"))
        return Response.json({ id: "folder-1", parentReference: { driveId: "drive-1" } });
      if (target.includes("/drives/drive-1/items/folder-1:/"))
        return Response.json({ id: "item-1", webUrl: "https://acme.sharepoint.com/sites/Sales/nda.docx" });
      if (target.endsWith("/activities")) return Response.json({ id: "1793611111000" });
      return Response.json({}, { status: 404 });
    }),
  );
}

const deliver = () =>
  handleIntakeDeliver(memory.db, {
    id: "job",
    kind: "intake.deliver",
    payload: { orgId: org, outboundId },
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

beforeEach(() => {
  vi.clearAllMocks();
  clearMicrosoftTokens();
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-encryption-secret-for-intake";
  mocks.downloadFile.mockResolvedValue(new Uint8Array([80, 75]).buffer);
});
afterAll(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

describe("replying in Teams", () => {
  it("uploads the documents to the channel's files, then posts in the thread, signed by the member", async () => {
    setup(true);
    await deliver();
    expect(calls.find((c) => c.url.includes("/drives/"))!.url).toBe(
      "https://graph.microsoft.com/v1.0/drives/drive-1/items/folder-1:/MikeGC/Review%20Acme%20NDA/nda.docx:/content?@microsoft.graph.conflictBehavior=rename",
    );
    const post = calls.find((c) => c.url.endsWith("/activities"))!;
    expect(post.url).toBe(
      "https://smba.trafficmanager.net/emea/v3/conversations/19%3Aabc%40thread.tacv2%3Bmessageid%3D1/activities",
    );
    expect(post.body).toEqual({
      type: "message",
      textFormat: "markdown",
      text:
        "Emma Chen \\(Legal\\):  \nApproved \\*with\\* edits.  \n  \n" +
        "Documents: [nda.docx](https://acme.sharepoint.com/sites/Sales/nda.docx)",
    });
    expect(memory.rows("intake_outbound")[0]).toMatchObject({
      status: "sent",
      external_id: "1793611111000",
      documents: [{ document_id: "d0", external_id: "https://acme.sharepoint.com/sites/Sales/nda.docx" }],
    });
  });
  it("names the documents instead when it has no document access", async () => {
    setup(false);
    await deliver();
    expect(calls.some((c) => c.url.includes("/drives/"))).toBe(false);
    const post = calls.find((c) => c.url.endsWith("/activities"))!;
    expect((post.body as { text: string }).text).toContain(
      "Documents from Legal: nda.docx. Ask Legal for a copy.",
    );
    expect(memory.rows("intake_outbound")[0]).toMatchObject({ status: "sent", documents: [{ left_out: true }] });
  });
});

describe("reading Teams activities", () => {
  it("takes out the bot's own mention and reads the HTML as text", () => {
    const activity = teamsActivity.parse({
      type: "message",
      id: "1",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      from: { id: "29:jane" },
      conversation: { id: "19:abc;messageid=1" },
      text: "<at>MikeGC</at> please <b>review</b> the NDA<br>by Friday",
      entities: [{ type: "mention", text: "<at>MikeGC</at>", mentioned: { id: `28:${appId}` } }],
    });
    expect(teamsActivityText(activity, appId)).toBe("please review the NDA\nby Friday");
  });
  it("names a sharing URL the way Graph's shares API does", () => {
    expect(shareId("https://acme.sharepoint.com/a b")).toBe(
      `u!${Buffer.from("https://acme.sharepoint.com/a b").toString("base64url")}`,
    );
    expect(teamsEscape("a_b <c> [d](e)")).toBe("a\\_b &lt;c&gt; \\[d\\]\\(e\\)");
  });
});
