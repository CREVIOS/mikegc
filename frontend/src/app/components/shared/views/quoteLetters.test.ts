import { describe, expect, it } from "vitest";
import { onlyLetters, strippedPosToOriginal } from "./quoteLetters";

describe("quote letters", () => {
    it("keeps the ASCII behaviour: letters and digits, lowercased", () => {
        expect(onlyLetters("Section 2.1, \"Term\"")).toBe("section21term");
    });

    it("keeps Bangla consonants, vowel signs and hasanta", () => {
        const stripped = onlyLetters("চুক্তির ধারা ৫।");
        expect(stripped).toBe("চুক্তিরধারা৫".normalize("NFD"));
        // Different vowel signs stay different.
        expect(onlyLetters("কি")).not.toBe(onlyLetters("কা"));
    });

    it("matches precomposed and decomposed spellings", () => {
        expect(onlyLetters("য়")).toBe(onlyLetters("য়"));
        expect(onlyLetters("কো")).toBe(onlyLetters("কো"));
        expect(onlyLetters("র\u200D্যাব")).toBe(onlyLetters("র্যাব"));
    });

    it("maps a stripped position back to the original character", () => {
        const original = "ধারা ৫: বাদী";
        const start = onlyLetters(original).indexOf(onlyLetters("বাদী"));
        expect(original.slice(strippedPosToOriginal(original, start))).toBe("বাদী");
        expect(strippedPosToOriginal("ab, cd", 2)).toBe(4);
        expect(strippedPosToOriginal("ab", 5)).toBe(2);
    });
});
