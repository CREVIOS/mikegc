import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { IntakeMessage } from "@mike/contracts";
import { IntakeMessages } from "./IntakeMessages";
import { parseIntakeDescription } from "./intakeDescription";

const DESCRIPTION = [
  "Will Chen asked for a memo.",
  "",
  "--- Original message ---",
  "From: Will Chen <will@mikeoss.com> in Slack",
  "Sent: 3 Nov 2026, 14:11 UTC",
  "",
  "Will Chen, 3 Nov 2026, 14:11 UTC:",
  "hi",
  "",
  "Will Chen, 3 Nov 2026, 14:14 UTC:",
  "produce a memo on non-compete enforceability in ny",
  "",
  "--- Not attached ---",
  "- big.zip: not a PDF, Word, Excel or PowerPoint file",
].join("\n");

const reply: IntakeMessage = {
  id: "reply-a",
  kind: "reply",
  body: "just general research",
  author_id: null,
  author_name: "Will Chen",
  created_at: "2026-11-03T19:17:50Z",
  external_author: { name: "Will Chen", email: null, source: "slack" },
};
const question: IntakeMessage = {
  id: "question-a",
  kind: "question",
  automated: true,
  body: "Is this tied to a specific employee?",
  author_id: null,
  author_name: "MikeGC",
  created_at: "2026-11-03T19:17:23Z",
};

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <IntakeMessages
      original={parseIntakeDescription(DESCRIPTION)}
      messages={[reply, question]}
      resolutions={[]}
      createdAt="2026-11-03T19:17:00Z"
      members={[]}
      documents={[]}
      uploading={[]}
      open={open}
      newReply
      retrying={[]}
      onOpenChange={setOpen}
      onOpenDocument={vi.fn()}
      onRetry={vi.fn()}
    />
  );
}

describe("IntakeMessages", () => {
  it("shows a resolution's reply on our side, named as the resolution, with how it went", () => {
    render(
      <IntakeMessages
        original={null}
        messages={[
          {
            id: "answer-a",
            kind: "answer",
            body: "Here are the agreed edits.",
            author_id: "lawyer-a",
            author_name: "Lawyer A",
            created_at: "2026-11-04T10:00:00Z",
            delivery: {
              outbound_id: "out-1",
              kind: "answer",
              status: "sent",
              error: null,
              sent_at: "2026-11-04T10:00:05Z",
              message_id: "answer-a",
              documents: [],
            },
          },
        ]}
        resolutions={[]}
        createdAt="2026-11-03T10:00:00Z"
        members={[]}
        documents={[]}
        uploading={[]}
        open
        newReply={false}
        retrying={[]}
        onOpenChange={vi.fn()}
        onOpenDocument={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const [bubble] = [
      ...screen.getByRole("list", { name: "Messages with the requester" })
        .children,
    ];
    expect(bubble!.className).toContain("justify-end");
    expect(bubble).toHaveTextContent("Lawyer A · Resolution");
    expect(bubble).toHaveTextContent("Here are the agreed edits.");
    expect(bubble).toHaveTextContent("Sent");
  });

  it("reads the thread the request came from, then the questions and replies, as one chat", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: /^Messages/ });
    expect(toggle).toHaveTextContent("Messages4New reply");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await user.click(toggle);
    const bubbles = [
      ...screen.getByRole("list", { name: "Messages with the requester" })
        .children,
    ];
    expect(
      bubbles.map((b) => b.querySelector("p:nth-of-type(2)")?.textContent),
    ).toEqual([
      "hi",
      "produce a memo on non-compete enforceability in ny",
      "Is this tied to a specific employee?",
      "just general research",
    ]);
    expect(bubbles[0]).toHaveTextContent("Will Chen · Slack");
    expect(bubbles[0]!.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-11-03T14:11:00.000Z",
    );
    expect(bubbles.map((b) => b.className.includes("justify-end"))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(
      screen.getByText("big.zip: not a PDF, Word, Excel or PowerPoint file"),
    ).toBeInTheDocument();
  });
});
