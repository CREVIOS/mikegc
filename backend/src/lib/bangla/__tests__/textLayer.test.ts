import { describe, expect, it } from "vitest";
import { textLayerQuality } from "../textLayer";

describe("text layer quality", () => {
    it("rejects Bangla re-encoded into junk code points (pdf.js on a gazette)", () => {
        const garbled = "এনািজȟ ǯর\u0336 েলটরী কিমশন আইন ২০২৩ এনািজȟ ǯর\u0336 েলটরী ǯর\u0336 এনািজȟ";
        expect(textLayerQuality(garbled)).toBe("garbled");
    });

    it("rejects Bangla whose glyph map is broken (LibreOffice output read back by pdf.js)", () => {
        // A PDF of "এই চুক্তি বাংলাদেশের আইন অনুযায়ী পরিচালিত হবে। …" as pdf.js extracts it.
        const extracted =
            "[Page 1]\nএই চুক্তি\u0006 বাংলাদে দে র আইন অনুযায়ী প রিরচা ক্তিল ত হদেব। উভয় পক্ষ এই চু ক্তি\u0006 র সকল ত\u001f  মে!দেন চলদেত বাধ্য থাক দেবন\nএবং মেকাদেনা রিবদেরাধ মে খা রি দেল তা ঢাকার আ ালদেত রিনষ্প ক্তি( হদেব।";
        expect(textLayerQuality(extracted)).toBe("garbled");
    });

    it("rejects an English OCR layer laid over a Bangla scan", () => {
        const junk = Array.from({ length: 6 }, () => "fAvta qeges eftE kOrta mAmla jAbe").join(" ");
        expect(textLayerQuality(junk)).toBe("garbled");
    });

    it("rejects pages of private-use or replacement characters", () => {
        expect(textLayerQuality("\uE001\uE002\uE003 \uE004\uE005\uFFFD\uFFFD\uE006\uE007\uE008\uE009\uE00A\uE00B\uE00C\uE00D\uE00E\uE00F\uE010\uE011\uE012")).toBe("garbled");
    });

    it("accepts real Bangla, English and mixed pages", () => {
        for (const text of [
            "এই চুক্তি বাংলাদেশের আইন অনুযায়ী পরিচালিত হবে। উভয় পক্ষ এতে সম্মত।",
            "IN THE SUPREME COURT OF BANGLADESH HIGH COURT DIVISION (SPECIAL ORIGINAL JURISDICTION) Writ Petition No. 1434 of 1988 IN THE MATTER OF an application under Article 102",
            "[Page 1]\nThe Borrower shall repay the Loan in 12 equal monthly instalments. ঋণগ্রহীতা ১২টি সমান মাসিক কিস্তিতে ঋণ পরিশোধ করবেন।",
            "Café résumé naïve façade — Müller v Öztürk (2019) 15 SCOB [2021] AD 1",
            "short",
        ]) {
            expect(textLayerQuality(text)).toBe("readable");
        }
    });
});
