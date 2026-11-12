import { describe, expect, it } from "vitest";
import {
    banglaDocumentFont,
    banglaFontEncoding,
    hasBijoyGlyphs,
    asciiDigitsToBangla,
    banglaDigitsToAscii,
    bijoyToUnicode,
    convertBijoyPassages,
    isBijoyFontName,
    isVisualOrderBangla,
    looksLikeBijoy,
    normalizeBangla,
    readablePdfText,
    reorderVisualBangla,
    repairVisualOrderBangla,
} from "..";

const nfc = (s: string) => s.normalize("NFC");

describe("bijoyToUnicode", () => {
    it.each([
        ["Avwg evsjvq Mvb MvB", "আমি বাংলায় গান গাই"],
        ["evsjv‡`k", "বাংলাদেশ"],
        // The masthead of an extraordinary Bangladesh Gazette.
        [
            "†iwR÷vW© bs wW G-1 evsjv‡`k †M‡RU AwZwi³ msL¨v",
            "রেজিস্টার্ড নং ডি এ-১ বাংলাদেশ গেজেট অতিরিক্ত সংখ্যা",
        ],
        ["Pzw³cÎ", "চুক্তিপত্র"],
        ["MYcÖRvZš¿x evsjv‡`k miKvi", "গণপ্রজাতন্ত্রী বাংলাদেশ সরকার"],
        ["AvBb, 2026", "আইন, ২০২৬"],
        ["‡KvU©", "কোর্ট"],
        ["Kvh©Ki", "কার্যকর"],
        ["Kg©Pvix", "কর্মচারী"],
        ["‡KŠk‡j", "কৌশলে"],
        ["aviv 23(1)|", "ধারা ২৩(১)।"],
        ["ˆea", "বৈধ"],
        // From a 2026 Supreme Court judgment's SutonnyMJ text layer.
        ["gš¿Yvj‡qi", "মন্ত্রণালয়ের"],
        ["†RjvRR Av`vj‡Zi", "জেলাজজ আদালতের"],
        // Reph typed before or after the vowel sign: কর্তৃক either way (a
        // known failure of other converters).
        ["KZ©„K", "কর্তৃক"],
        ["KZ„©K", "কর্তৃক"],
    ])("converts %s", (bijoy, unicode) => {
        expect(bijoyToUnicode(bijoy)).toBe(nfc(unicode));
    });

    it("returns NFC text, so it matches Unicode typed elsewhere", () => {
        const converted = bijoyToUnicode("evsjvq");
        expect(converted).toBe(converted.normalize("NFC"));
        expect(converted).toBe(nfc("বাংলায়"));
    });
});

describe("Bijoy detection", () => {
    it("recognises the MJ font family, but not its Unicode OMJ release", () => {
        for (const font of ["SutonnyMJ", "ABCDEF+SutonnyMJ", "SutonnyMJ Bold", "SushreeMJ", "SutonnyMJ-Italic"]) {
            expect(banglaFontEncoding(font)).toBe("bijoy");
            expect(isBijoyFontName(font)).toBe(true);
        }
        // SutonnyOMJ is the Unicode (OpenType) Sutonny: converting it would
        // garble correct text.
        for (const font of ["SutonnyOMJ", "ABCDEF+SutonnyOMJ", "Nikosh", "Kalpurush", "SolaimanLipi", "Times New Roman", "Noto Sans Bengali", "", null]) {
            expect(banglaFontEncoding(font)).toBe("unicode");
        }
        expect(banglaFontEncoding("AdarshaLipiNormal")).toBe("legacy");
    });

    it("needs a Bijoy-only glyph before English-like patterns count", () => {
        for (const text of [
            "Average aviation costs which were written off",
            "House 12, Gulshan Avenue, Dhaka 1212",
        ]) {
            expect(looksLikeBijoy(text)).toBe(false);
            expect(hasBijoyGlyphs(text)).toBe(false);
        }
        expect(hasBijoyGlyphs("Avgvi gš¿Yvj‡qi")).toBe(true);
    });

    it("accepts Bijoy passages", () => {
        expect(looksLikeBijoy("GB Pzw³ AvBb Abyhvqx Kvh©Ki nB‡e Ges Dfq c¶ gvb‡eb")).toBe(true);
        expect(looksLikeBijoy("†iwR÷vW© bs wW G-1 evsjv‡`k †M‡RU")).toBe(true);
    });

    it("never takes English, European or Unicode Bangla text for Bijoy", () => {
        for (const text of [
            "This Agreement shall be governed by the laws of Bangladesh.",
            "© 2026 Acme Ltd. All rights reserved.",
            "Section 12 — Termination; see § 4 and Müller v Öztürk (2019).",
            "Prix: 250 € — résumé, façade, naïve",
            "এই চুক্তি বাংলাদেশের আইন অনুযায়ী পরিচালিত হবে।",
            "Total Tk 1,25,000 payable by 30 June 2026",
        ]) {
            expect(looksLikeBijoy(text)).toBe(false);
        }
    });

    it("converts only the Bijoy lines of mixed text", () => {
        const text = "Registered No. DA-1\nevsjv‡`k †M‡RU AwZwi³ msL¨v\nThe Gazette is published by the Government.";
        expect(convertBijoyPassages(text)).toBe(
            `Registered No. DA-1\n${nfc("বাংলাদেশ গেজেট অতিরিক্ত সংখ্যা")}\nThe Gazette is published by the Government.`,
        );
    });

    it("converts short lines on a page that is Bijoy throughout, but keeps page markers", () => {
        const page = "[Page 1]\nevsjv‡`k †M‡RU AwZwi³ msL¨v\nAvBb bs 5\n†iwR÷vW© bs wW G-1";
        const out = convertBijoyPassages(page).split("\n");
        expect(out[0]).toBe("[Page 1]");
        expect(out[2]).toBe(nfc("আইন নং ৫"));
    });
});

describe("visual-order repair", () => {
    // How a PDF saved from Word often stores "আমি বাংলাদেশের নাগরিক এবং
    // কোর্টের নিকট আবেদন করিতেছি": each ি ে ৈ before its consonant.
    const visual = "আিম বাংলােদেশর নাগিরক এবং েকাের্টর িনকট আেবদন কিরেতিছ";
    const logical = "আমি বাংলাদেশের নাগরিক এবং কোর্টের নিকট আবেদন করিতেছি";

    it("detects and repairs visual order", () => {
        expect(isVisualOrderBangla(visual)).toBe(true);
        expect(reorderVisualBangla(visual)).toBe(nfc(logical));
    });

    it("leaves correctly ordered Bangla alone", () => {
        expect(isVisualOrderBangla(logical)).toBe(false);
        expect(repairVisualOrderBangla(logical)).toBe(logical);
        expect(readablePdfText(logical)).toBe(nfc(logical));
    });

    it("leaves English alone", () => {
        const english = "[Page 1]\nThis Agreement is made on 1 January 2026.";
        expect(readablePdfText(english)).toBe(english);
    });
});

describe("normalisation", () => {
    it("unifies the spellings of য় ো and khanda-ta", () => {
        expect(normalizeBangla("য়")).toBe(normalizeBangla("য়"));
        expect(normalizeBangla("কো")).toBe("কো");
        expect(normalizeBangla("হঠাত্\u200D")).toBe("হঠাৎ");
    });

    it("converts digits both ways", () => {
        expect(banglaDigitsToAscii("ধারা ২৩(১), ২০২৬")).toBe("ধারা 23(1), 2026");
        expect(asciiDigitsToBangla("Act 63 of 2026")).toBe("Act ৬৩ of ২০২৬");
    });
});

describe("Bangla document font", () => {
    it("defaults to a Unicode font every Windows has, and refuses Bijoy fonts", () => {
        expect(banglaDocumentFont({})).toBe("Nirmala UI");
        expect(banglaDocumentFont({ SPECTRE_BANGLA_FONT: "Nikosh" })).toBe("Nikosh");
        expect(banglaDocumentFont({ SPECTRE_BANGLA_FONT: "SutonnyMJ" })).toBe("Nirmala UI");
        expect(banglaDocumentFont({ SPECTRE_BANGLA_FONT: 'x"/><evil' })).toBe("Nirmala UI");
    });
});
