import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractDocxBodyText } from "../../../docxTrackedChanges";
import { findBangladeshCaseCitations } from "../../citations";
import { redlineUseCase, REDLINE_AUTHOR } from "../buildExamples";
import { BANGLADESH_USE_CASES } from "../useCases";

describe("Bangladesh corporate use cases", () => {
    it("covers five distinct corporate documents", () => {
        expect(BANGLADESH_USE_CASES.map((u) => u.id)).toEqual([
            "facility-agreement",
            "vendor-msa",
            "appointment-letter",
            "distribution-agreement",
            "shareholders-agreement",
        ]);
    });

    for (const useCase of BANGLADESH_USE_CASES) {
        describe(useCase.title, () => {
            it("redlines the draft with real Word tracked changes, every edit applied", async () => {
                const { draft, redline, changes, acceptedText } = await redlineUseCase(useCase);
                const draftText = await extractDocxBodyText(draft);
                for (const edit of useCase.edits) {
                    // Each edit anchors on the draft as written and lands in the result.
                    expect(draftText).toContain(edit.find);
                    expect(acceptedText).toContain(edit.replace);
                }
                expect(changes).toHaveLength(useCase.edits.length);

                const xml = await (await JSZip.loadAsync(redline)).file("word/document.xml")!.async("string");
                expect(xml).toContain(`w:author="${REDLINE_AUTHOR}"`);
                expect(xml).toMatch(/<w:ins /);
                expect(xml).toMatch(/<w:del /);
                // Each change starts and ends on a word boundary: never a
                // fragment of a word, never a lone vowel sign.
                const letter = /[\p{L}\p{M}\p{N}]/u;
                for (const change of changes) {
                    const before = change.contextBefore.slice(-1);
                    const after = change.contextAfter.slice(0, 1);
                    for (const span of [change.deletedText, change.insertedText]) {
                        if (!span) continue;
                        expect(letter.test(before) && letter.test(span[0])).toBe(false);
                        expect(letter.test(after) && letter.test(span.at(-1)!)).toBe(false);
                        expect(span).not.toMatch(/^\p{M}/u);
                    }
                }
            });

            it("cites a Bangladeshi provision for every change, and no unverifiable case law", () => {
                for (const edit of useCase.edits) {
                    expect(edit.provision.length).toBeGreaterThan(5);
                    expect(edit.reason.length).toBeGreaterThan(20);
                }
                const allText = [useCase.coverNote, ...useCase.edits.map((e) => e.replace)].join(" ");
                expect(findBangladeshCaseCitations(allText)).toEqual([]);
                expect(useCase.toConfirm.length).toBeGreaterThan(0);
            });
        });
    }

    it("keeps unchanged words out of the markup", async () => {
        const facility = BANGLADESH_USE_CASES.find((u) => u.id === "facility-agreement")!;
        const { changes } = await redlineUseCase(facility);
        const interest = changes.find((c) => c.provision.startsWith("Contract Act, 1872, s.74"))!;
        // "interest shall accrue on the overdue amount at" is not re-marked.
        expect(interest.deletedText.startsWith("4%")).toBe(true);
        expect(interest.insertedText.startsWith("2%")).toBe(true);
    });
});
