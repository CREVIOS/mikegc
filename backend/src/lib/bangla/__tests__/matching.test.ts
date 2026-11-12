import { describe, expect, it } from "vitest";
import { findTextMatches, normalizeWithMap } from "../../../modules/chat/engine/tools/documentOps";

describe("Bangla text matching", () => {
    const text = "চুক্তির ধারা ৫ অনুযায়ী বিবাদী ক্ষতিপূরণ দিতে বাধ্য।";

    it("keeps vowel signs and hasanta when punctuation is stripped", () => {
        const { norm } = normalizeWithMap("কি কী কু", { stripPunctuation: true });
        expect(norm).toBe("কি কী কু".normalize("NFD"));
        expect(norm).not.toBe("ক ক ক");
    });

    it("finds a phrase however য় and ো are spelled", () => {
        const decomposedQuery = "অনুযায়ী"; // য + nukta instead of U+09DF
        const { hits } = findTextMatches({ text: text.replace("য়", "য়"), query: decomposedQuery, maxResults: 5, contextChars: 10 });
        expect(hits).toHaveLength(1);
        expect(hits[0].excerpt).toBe("অনুযায়ী".replace("য়", "য়"));
    });

    it("ignores zero-width joiners", () => {
        const { hits } = findTextMatches({ text: "র‍্যাব অভিযান", query: "র্যাব", maxResults: 5, contextChars: 0 });
        expect(hits).toHaveLength(1);
    });

    it("does not match a different vowel", () => {
        const { hits } = findTextMatches({ text, query: "দাতে", maxResults: 5, contextChars: 0 });
        expect(hits).toHaveLength(0);
    });
});
