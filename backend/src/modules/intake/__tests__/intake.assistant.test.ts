import { describe, expect, it } from "vitest";
import type { IntakeDocument, IntakeMessage, IntakeRequest } from "@mike/contracts";
import { composeIntakeBrief } from "../intake.assistant";

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
        author_name: "MikeGC",
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
    expect(brief.indexOf("MikeGC, preprocessing")).toBeLessThan(
      brief.indexOf("Jane Business, reply from the requester in slack"),
    );
    expect(brief).toContain("- NDA.docx (revised since it arrived)");
    expect(brief).toContain("- Schedule.pdf (still processing)");
  });

  it("stays within its limit", () => {
    const long = { ...request, description: "x".repeat(60000) };
    const brief = composeIntakeBrief(long, [], []);
    expect(brief.length).toBeLessThan(41000);
    expect(brief.endsWith("[Shortened to fit.]")).toBe(true);
  });
});
