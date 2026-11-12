import { describe, expect, it } from "vitest";
import {
    BANGLADESH_PRACTICE_PROMPT,
    BANGLA_WRITING_PROMPT,
    defaultJurisdiction,
    isBangladeshJurisdiction,
    isBangladeshPractice,
    jurisdictionPracticePrompt,
} from "../practicePrompt";

describe("Bangladesh practice prompt", () => {
    it("recognises Bangladesh however it is written", () => {
        for (const value of ["Bangladesh", " bangladesh ", "People's Republic of Bangladesh", "বাংলাদেশ", "BD"]) {
            expect(isBangladeshJurisdiction(value)).toBe(true);
        }
        for (const value of ["India", "Singapore", "", null, undefined, "bdx"]) {
            expect(isBangladeshJurisdiction(value)).toBe(false);
        }
    });

    it("defaults a deployment to Bangladesh unless told otherwise", () => {
        expect(defaultJurisdiction({})).toBe("Bangladesh");
        expect(defaultJurisdiction({ SPECTRE_DEFAULT_JURISDICTION: "none" })).toBeNull();
        // An empty value, as a copied .env.example leaves it, keeps the default.
        expect(defaultJurisdiction({ SPECTRE_DEFAULT_JURISDICTION: " " })).toBe("Bangladesh");
        expect(defaultJurisdiction({ SPECTRE_DEFAULT_JURISDICTION: "OFF" })).toBeNull();
        expect(defaultJurisdiction({ SPECTRE_DEFAULT_JURISDICTION: "India" })).toBe("India");
    });

    it("lets the user's own jurisdiction decide before the deployment default", () => {
        expect(isBangladeshPractice(null, {})).toBe(true);
        expect(isBangladeshPractice("Singapore", {})).toBe(false);
        expect(
            isBangladeshPractice("Bangladesh", { SPECTRE_DEFAULT_JURISDICTION: "none" }),
        ).toBe(true);
        expect(isBangladeshPractice(null, { SPECTRE_DEFAULT_JURISDICTION: "none" })).toBe(false);
    });

    it("adds both blocks for Bangladeshi work and nothing otherwise", () => {
        expect(jurisdictionPracticePrompt(null, {})).toBe(
            `${BANGLADESH_PRACTICE_PROMPT}\n\n${BANGLA_WRITING_PROMPT}`,
        );
        expect(jurisdictionPracticePrompt("Singapore", {})).toBe("");
    });

    it("keeps the guarantees lawyers rely on", () => {
        // No invented authority, and CourtListener is never used for Bangladesh.
        expect(BANGLADESH_PRACTICE_PROMPT).toContain("Never invent a case");
        expect(BANGLADESH_PRACTICE_PROMPT).toContain("never use it for Bangladeshi cases");
        // Ordinance-era law must be checked before it is relied on.
        expect(BANGLADESH_PRACTICE_PROMPT).toContain("check its current status before relying on it");
        // Citation forms the reports actually use.
        expect(BANGLADESH_PRACTICE_PROMPT).toContain("56 DLR (AD) 1");
        expect(BANGLADESH_PRACTICE_PROMPT).toContain("15 SCOB [2021] AD 1");
        // Bangla is written as Unicode with the dari and Bangla digits.
        expect(BANGLA_WRITING_PROMPT).toContain("Unicode Bangla only");
        expect(BANGLA_WRITING_PROMPT).toContain("।");
        expect(BANGLA_WRITING_PROMPT).toContain("evsjv‡`k");
    });
});
