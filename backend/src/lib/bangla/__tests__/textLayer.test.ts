import { describe, expect, it } from "vitest";
import { textLayerQuality } from "../textLayer";

describe("text layer quality", () => {
    it("rejects Bangla re-encoded into junk code points (pdf.js on a gazette)", () => {
        const garbled = "এনািজȟ ǯর̶ েলটরী কিমশন আইন ২০২৩ এনািজȟ ǯর̶ েলটরী ǯর̶ এনািজȟ";
        expect(textLayerQuality(garbled)).toBe("garbled");
    });

    it("rejects an English OCR layer laid over a Bangla scan", () => {
        const junk = Array.from({ length: 6 }, () => "fAvta qeges eftE kOrta mAmla jAbe").join(" ");
        expect(textLayerQuality(junk)).toBe("garbled");
    });

    it("rejects pages of private-use or replacement characters", () => {
        expect(textLayerQuality(" ��")).toBe("garbled");
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
