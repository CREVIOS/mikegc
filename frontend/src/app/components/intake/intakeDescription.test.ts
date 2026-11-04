import { describe, expect, it } from "vitest";
import {
  parseIntakeDescription,
  parseIntakeSentTime,
} from "./intakeDescription";

const THREAD = [
  "Will Chen asked for two memos.",
  "",
  "--- Original message ---",
  "From: Will Chen <will@mikeoss.com> in Slack",
  "Sent: 3 Nov 2026, 14:11 UTC",
  "",
  "Will Chen, 3 Nov 2026, 14:11 UTC:",
  "new question what is a contract",
  "",
  "Will Chen, 3 Nov 2026, 14:14 UTC:",
  "produce a memo",
  "",
  "on two lines",
  "",
  "Ada Lovelace, 4 Sept 2026, 09:05 UTC:",
  "hi",
].join("\n");

describe("parseIntakeDescription", () => {
  it("reads a thread into its summary and messages", () => {
    const parsed = parseIntakeDescription(THREAD)!;
    expect(parsed.summary).toBe("Will Chen asked for two memos.");
    expect(parsed.sender).toBe("Will Chen");
    expect(parsed.channel).toBe("Slack");
    expect(parsed.subject).toBeNull();
    expect(parsed.entries).toEqual([
      {
        author: "Will Chen",
        sentAt: "2026-11-03T14:11:00.000Z",
        text: "new question what is a contract",
      },
      {
        author: "Will Chen",
        sentAt: "2026-11-03T14:14:00.000Z",
        text: "produce a memo\n\non two lines",
      },
      {
        author: "Ada Lovelace",
        sentAt: "2026-09-04T09:05:00.000Z",
        text: "hi",
      },
    ]);
    // What follows the summary is kept as written, for saving an edited summary.
    expect(`${parsed.summary}\n\n${parsed.original}`).toBe(THREAD);
  });

  it("reads an email as one message, with its subject and what was left off", () => {
    const parsed = parseIntakeDescription(
      [
        "Summary.",
        "",
        "--- Original message ---",
        "From: Sam Lee <sam@example.com>",
        "Sent: 2 Nov 2026, 09:14 UTC",
        "Subject: NDA",
        "",
        "Please review.",
        "",
        "Thanks",
        "[Message shortened to fit.]",
        "",
        "--- Not attached ---",
        "- big.zip: not a PDF, Word, Excel or PowerPoint file",
      ].join("\n"),
    )!;
    expect(parsed.channel).toBeNull();
    expect(parsed.subject).toBe("NDA");
    expect(parsed.shortened).toBe(true);
    expect(parsed.entries).toEqual([
      {
        author: "Sam Lee",
        sentAt: "2026-11-02T09:14:00.000Z",
        text: "Please review.\n\nThanks",
      },
    ]);
    expect(parsed.notAttached).toEqual([
      "big.zip: not a PDF, Word, Excel or PowerPoint file",
    ]);
  });

  it("leaves a description without an original message alone", () => {
    expect(parseIntakeDescription("Just the message.")).toBeNull();
    expect(
      parseIntakeDescription("Summary.\n\n--- Original message ---\nrewritten"),
    ).toBeNull();
  });

  it("reads only well-formed times", () => {
    expect(parseIntakeSentTime("31 Dec 2026, 23:59 UTC")).toBe(
      "2026-12-31T23:59:00.000Z",
    );
    expect(parseIntakeSentTime("yesterday")).toBeNull();
  });
});
