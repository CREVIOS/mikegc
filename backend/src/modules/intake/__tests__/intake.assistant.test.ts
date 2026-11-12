import { describe, expect, it } from "vitest";
import type { IntakeDocument, IntakeMessage, IntakeRequest } from "@mike/contracts";
import type { Db } from "../../../lib/supabase";
import { composeIntakeBrief, intakeChatBrief } from "../intake.assistant";

const request = {
  id: "r1",
  subject: "Supplier NDA",
  description: "Please review the attached NDA.",
  state: "in_review",
  requester_name: "Jane Business",
  requester_email: "jane@acme.test",
  requester_team: "Procurement",
  assignee_name: "Lawyer A",
  requested_by_date: "2026-11-10",
  created_at: "2026-11-03T10:00:00Z",
} as IntakeRequest;

describe("composeIntakeBrief", () => {
  it("reads the request, its history oldest first, and its documents", () => {
    const messages = [
      {
        id: "m1",
        kind: "note",
        automated: true,
        purpose: "preprocessing",
        author_id: null,
        author_name: "Spectre",
        body: "AI preprocessing: two clauses to check.",
        created_at: "2026-11-03T10:01:00Z",
      },
      {
        id: "m2",
        kind: "reply",
        author_id: null,
        author_name: "Jane Business",
        external_author: { name: "Jane Business", email: null, source: "slack" },
        body: "It's for a new supplier.",
        created_at: "2026-11-03T11:00:00Z",
      },
    ] as IntakeMessage[];
    const documents = [
      { document_id: "d1", filename: "NDA.docx", status: "ready", revised: true },
      { document_id: "d2", filename: "Schedule.pdf", status: "processing", revised: false },
    ] as IntakeDocument[];
    const brief = composeIntakeBrief(request, messages, documents);
    expect(brief).toContain("Subject: Supplier NDA");
    expect(brief).toContain("Status: In progress");
    expect(brief).toContain("Requester: Jane Business <jane@acme.test> (Procurement)");
    expect(brief).toContain("Reviewer: Lawyer A");
    expect(brief).toContain("Please review the attached NDA.");
    expect(brief.indexOf("Spectre, preprocessing")).toBeLessThan(
      brief.indexOf("Jane Business, reply from the requester in slack"),
    );
    expect(brief).toContain("- NDA.docx (revised since it arrived)");
    expect(brief).toContain("- Schedule.pdf (still processing)");
  });

  it("stays within its limit", () => {
    const long = { ...request, description: "x".repeat(60000) };
    const brief = composeIntakeBrief(long, [], []);
    expect(brief.length).toBeLessThanOrEqual(40000);
    expect(brief).toContain("[Shortened to fit.]");
    expect(brief.endsWith("DOCUMENTS\nNone.")).toBe(true);
  });

  it("keeps the newest history and the documents when the brief is too long", () => {
    // A full description and a full note used to push everything after them
    // off the end: the requester's latest reply and the document list.
    const long = { ...request, description: "d".repeat(20000) };
    const messages = [
      note("m1", "a".repeat(20000), "2026-11-03T10:01:00Z"),
      note("m2", "b".repeat(20000), "2026-11-03T10:02:00Z"),
      {
        ...note("m3", "The supplier is Acme Ltd.", "2026-11-03T11:00:00Z"),
        kind: "reply",
        author_name: "Jane Business",
      } as IntakeMessage,
    ];
    const documents = [
      { document_id: "d1", filename: "NDA.docx", status: "ready", revised: false },
    ] as IntakeDocument[];
    const brief = composeIntakeBrief(long, messages, documents);
    expect(brief.length).toBeLessThanOrEqual(40000);
    expect(brief).toContain("The supplier is Acme Ltd.");
    expect(brief).toContain("- NDA.docx");
    expect(brief).toContain("left out to fit.]");
    // The oldest entry went first; the description kept at least half the room.
    expect(brief).not.toContain("a".repeat(100));
    expect(brief).toContain("d".repeat(15000));
  });

  it("keeps the whole description when the history is short", () => {
    const long = { ...request, description: "d".repeat(39000) };
    const brief = composeIntakeBrief(
      long,
      [note("m1", "Short note.", "2026-11-03T10:01:00Z")],
      [],
    );
    expect(brief.length).toBeLessThanOrEqual(40000);
    expect(brief).toContain("Short note.");
    expect(brief).not.toContain("left out to fit");
  });
});

function note(id: string, body: string, created_at: string) {
  return {
    id,
    kind: "note",
    automated: false,
    author_id: "u1",
    author_name: "Lawyer A",
    body,
    created_at,
  } as IntakeMessage;
}

describe("intakeChatBrief", () => {
  it("reads every page of the history and keeps the newest entries", async () => {
    const all = Array.from({ length: 230 }, (_, i) =>
      note(`m${i}`, `Entry ${i}.`, `2026-11-03T10:00:00.${String(i).padStart(3, "0")}Z`),
    );
    const pages: unknown[] = [];
    const db = {
      from: (table: string) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: table === "intake_requests" ? { org_id: "org-1" } : { kind: "team" },
            error: null,
          }),
        };
        return builder;
      },
      rpc: async (name: string, args: Record<string, number>) => {
        if (name === "intake_can_read") return { data: true, error: null };
        if (name === "intake_get_request") return { data: request, error: null };
        if (name === "intake_list_documents") return { data: [], error: null };
        if (name === "intake_read_history") {
          pages.push([args.p_offset, args.p_limit]);
          return {
            data: all.slice(args.p_offset, args.p_offset + args.p_limit),
            error: null,
          };
        }
        throw new Error(`Unexpected rpc ${name}`);
      },
    } as unknown as Db;

    const result = await intakeChatBrief(db, "u1", "r1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pages).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(result.data.brief).toContain("Entry 229.");
    expect(result.data.brief).toContain("Entry 150.");
    expect(result.data.brief).not.toContain("Entry 149.");
  });
});
