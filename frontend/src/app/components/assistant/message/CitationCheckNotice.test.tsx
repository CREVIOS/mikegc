import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationCheckNotice } from "./CitationCheckNotice";

describe("CitationCheckNotice", () => {
    it("lists each unverified citation in full and says what to do", () => {
        render(<CitationCheckNotice unverified={["70 DLR (AD) 99", "15 SCOB [2021] AD 1"]} />);
        const note = screen.getByRole("note", { name: "Citations not verified" });
        expect(note).toHaveTextContent("2 citations not verified");
        expect(note).toHaveTextContent("Check them in the law report before relying on them.");
        expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
            "70 DLR (AD) 99",
            "15 SCOB [2021] AD 1",
        ]);
    });

    it("uses the singular for one citation and renders nothing for none", () => {
        const { container, rerender } = render(<CitationCheckNotice unverified={["70 DLR (AD) 99"]} />);
        expect(screen.getByRole("note")).toHaveTextContent("1 citation not verified");
        expect(screen.getByRole("note")).toHaveTextContent("Check it in the law report");
        rerender(<CitationCheckNotice unverified={[]} />);
        expect(container).toBeEmptyDOMElement();
    });
});
