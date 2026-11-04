import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IntakeDescription } from "./IntakeDetailsPanel";

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
].join("\n");

describe("IntakeDescription with an original message", () => {
  it("shows only the summary; the message reads in Messages", () => {
    render(
      <IntakeDescription
        value={DESCRIPTION}
        editable
        locked={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Will Chen asked for a memo.")).toBeInTheDocument();
    expect(screen.queryByText(/Original message/)).not.toBeInTheDocument();
    expect(screen.queryByText(/produce a memo/)).not.toBeInTheDocument();
  });

  it("edits only the summary and keeps the message as it was", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <IntakeDescription
        value={DESCRIPTION}
        editable
        locked={false}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit request" }));
    const box = screen.getByRole("textbox", { name: "Request" });
    expect(box).toHaveValue("Will Chen asked for a memo.");
    await user.clear(box);
    await user.type(box, "A memo on New York non-competes.");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSave).toHaveBeenCalledWith(
      DESCRIPTION.replace(
        "Will Chen asked for a memo.",
        "A memo on New York non-competes.",
      ),
    );
  });

  it("limits the summary to the room the message under it leaves", async () => {
    const user = userEvent.setup();
    const description = `${DESCRIPTION}\n${"x".repeat(15000)}`;
    const original = description.slice(description.indexOf("--- Original message ---"));
    render(
      <IntakeDescription
        value={description}
        editable
        locked={false}
        onSave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit request" }));
    // The summary and the message, two newlines apart, fit 20,000 characters.
    expect(screen.getByRole("textbox", { name: "Request" })).toHaveAttribute(
      "maxLength",
      String(20000 - original.length - 2),
    );
  });

  it("shows a description without one as written", () => {
    render(
      <IntakeDescription
        value="Just the message."
        editable={false}
        locked={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Just the message.")).toBeInTheDocument();
  });
});
