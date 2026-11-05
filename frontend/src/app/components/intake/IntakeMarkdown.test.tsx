import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntakeMarkdown } from "./IntakeMarkdown";

describe("IntakeMarkdown", () => {
  it("renders headings, lists, emphasis and tables", () => {
    const { container } = render(
      <IntakeMarkdown
        text={[
          "## Summary",
          "",
          "**Cannot be signed** as is.",
          "",
          "- Term: 2 years",
          "- Law: blank",
          "",
          "| Clause | Issue |",
          "| --- | --- |",
          "| Term | Too short |",
        ].join("\n")}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Summary" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cannot be signed").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector("h2")).toBeNull();
  });

  it("keeps the numbering of a list that starts past 1", () => {
    render(<IntakeMarkdown text={"3. Third\n4. Fourth"} />);
    expect(screen.getByRole("list")).toHaveAttribute("start", "3");
  });

  it("never renders raw HTML, images or unsafe links from the report", () => {
    const { container } = render(
      <IntakeMarkdown
        text={[
          '<img src="https://tracker.test/pixel.gif">',
          "",
          "![Signed copy](https://tracker.test/pixel.png)",
          "",
          "[Open](javascript:alert(1)) and [docs](https://example.test/guide)",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Signed copy")).toBeInTheDocument();
    expect(screen.getByText("Open")).not.toHaveAttribute(
      "href",
      expect.stringContaining("javascript"),
    );
    const docs = screen.getByRole("link", { name: "docs" });
    expect(docs).toHaveAttribute("href", "https://example.test/guide");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", "noopener noreferrer");
  });
});
