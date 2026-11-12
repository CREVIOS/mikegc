import { describe, expect, it } from "vitest";
import { generatePaperBook } from "./documentOps";
import { isDocumentMutatingTool, TOOLS } from "./toolSchemas";

const db = {} as never;

describe("build_paper_book", () => {
    it("is advertised and treated as creating a document", () => {
        expect(TOOLS.some((tool) => tool.function.name === "build_paper_book")).toBe(true);
        expect(isDocumentMutatingTool("build_paper_book")).toBe(true);
    });

    it("needs a cause title and at least one document", async () => {
        const docStore = new Map();
        expect(await generatePaperBook({ title: " ", items: [{}], userId: "u", db, docStore })).toMatchObject({
            error: expect.stringContaining("cause title"),
        });
        expect(await generatePaperBook({ title: "FA 1 of 2026", items: [], userId: "u", db, docStore })).toMatchObject({
            error: expect.stringContaining("at least one"),
        });
    });

    it("uses only documents in the conversation, each with a description and a part", async () => {
        const docStore = new Map([["doc-0", { storage_path: "p", file_type: "pdf", filename: "memo.pdf" }]]);
        const result = await generatePaperBook({
            title: "FA 1 of 2026",
            items: [
                { doc_id: "doc-9", description: "Judgment", part: "I" },
                { doc_id: "doc-0", description: "", part: "III" },
            ],
            userId: "u",
            db,
            docStore,
        });
        expect(result).toMatchObject({
            error: expect.stringMatching(/Item 1: "doc-9" is not a document in this conversation\. Item 2: give a description and a part/),
        });
    });
});
