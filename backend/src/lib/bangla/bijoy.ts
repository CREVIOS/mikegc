// Legacy Bijoy (SutonnyMJ family) Bangla to Unicode.
//
// Before Unicode Bangla was common, Bangladeshi offices typed Bangla with the
// Bijoy keyboard into "MJ" fonts (SutonnyMJ, SutonnyOMJ, ...). Those fonts
// draw Bangla glyphs over Latin-1 code points, so the file itself holds text
// such as "evsjv‡`k" for বাংলাদেশ. Gazette PDFs, court orders and older
// contracts still arrive like this. The model cannot read it, search cannot
// find it, and quotes cannot match it, so Spectre converts it when it reads a
// document (never in the file itself; see docs/bangladesh.md).
//
// Bijoy stores glyphs in visual order: the vowel signs ি ে ৈ are typed before
// the consonant they follow in Unicode, and reph (র্, "©") after the cluster
// it sits on. The conversion maps each glyph, then moves those signs.
//
// The glyph table follows the MIT-licensed bn-ansi-to-unicode package
// (Copyright (c) 2022 BinduLogic LLC; see CREDITS.md). The conversion
// algorithm here is Spectre's own.

import { BENGALI_CONSONANT, hasBengali, normalizeBangla } from "./normalize";

/** Single glyphs: independent vowels, consonants, conjuncts, digits, dari. */
const GLYPHS: Readonly<Record<string, string>> = {
    "°": "ক্ক", "±": "ক্ট", "²": "ক্ষ্ণ", "³": "ক্ত", "´": "ক্ম", "µ": "ক্র",
    "¶": "ক্ষ", "·": "ক্স", "¸": "গু", "¹": "জ্ঞ", "º": "গ্দ", "»": "গ্ধ",
    "¼": "ঙ্ক", "½": "ঙ্গ", "¾": "জ্জ", "¿": "্ত্র", "À": "জ্ঝ", "Á": "জ্ঞ",
    "Â": "ঞ্চ", "Ã": "ঞ্ছ", "Ä": "ঞ্জ", "Å": "ঞ্ঝ", "Æ": "ট্ট", "Ç": "ড্ড",
    "È": "ণ্ট", "É": "ণ্ঠ", "Ê": "ণ্ড", "Ë": "ত্ত", "Ì": "ত্থ", "Î": "ত্র",
    "Ï": "দ্দ", "Ð": "ণ্ড", "Ñ": "-", "Ò": "“", "Ó": "”", "Ô": "‘", "Õ": "’",
    "×": "দ্ধ", "Ø": "দ্ব", "Ù": "দ্ম", "Ú": "ন্ঠ", "Û": "ন্ড", "Ü": "ন্ধ",
    "Ý": "ন্স", "Þ": "প্ট", "ß": "প্ত", "à": "প্প", "á": "প্স", "â": "ব্জ",
    "ã": "ব্দ", "ä": "ব্ধ", "å": "ভ্র", "ç": "ম্ফ", "é": "ল্ক", "ê": "ল্গ",
    "ë": "ল্ট", "ì": "ল্ড", "í": "ল্প", "î": "ল্ফ", "ï": "শু", "ð": "শ্চ",
    "ñ": "শ্ছ", "ò": "ষ্ণ", "ó": "ষ্ট", "ô": "ষ্ঠ", "õ": "ষ্ফ", "ö": "স্খ",
    "÷": "স্ট", "ø": "স্ন", "ù": "স্ফ", "û": "হু", "ü": "হৃ", "ý": "হ্ন",
    "ÿ": "ক্ষ", "þ": "হ্ম",
    A: "অ", B: "ই", C: "ঈ", D: "উ", E: "ঊ", F: "ঋ", G: "এ", H: "ঐ", I: "ও",
    J: "ঔ", K: "ক", L: "খ", M: "গ", N: "ঘ", O: "ঙ", P: "চ", Q: "ছ", R: "জ",
    S: "ঝ", T: "ঞ", U: "ট", V: "ঠ", W: "ড", X: "ঢ", Y: "ণ", Z: "ত", _: "থ",
    "`": "দ", a: "ধ", b: "ন", c: "প", d: "ফ", e: "ব", f: "ভ", g: "ম", h: "য",
    i: "র", j: "ল", k: "শ", l: "ষ", m: "স", n: "হ", o: "ড়", p: "ঢ়", q: "য়",
    r: "ৎ", s: "ং", t: "ঃ", u: "ঁ",
    "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪", "5": "৫", "6": "৬",
    "7": "৭", "8": "৮", "9": "৯",
    "•": "ঙ্", "|": "।",
    // Half forms that join the next consonant.
    "®": "ষ্", "¯": "স্", "”": "চ্", "˜": "দ্", "™": "দ্", "š": "ন্", "›": "ন্",
    "¤": "ম্",
    // Phalas and other forms that join the previous consonant.
    "&": "্‌", "ú": "্প", "è": "্ন", "^": "্ব", "‘": "্তু", "’": "্থ",
    "‹": "্ক", "Œ": "্ক্র", "—": "্ত", "Í": "্ত", "œ": "্ন", "Ÿ": "্ব",
    "¡": "্ব", "¢": "্ভ", "£": "্ভ্র", "¥": "্ম", "¦": "্ব", "§": "্ম",
    "¨": "্য", "ª": "্র", "«": "্র", "¬": "্ল", "­": "্ল", "Ö": "্র",
    // Vowel signs that follow their consonant.
    v: "া", x: "ী", y: "ু", z: "ু", "æ": "ু", "“": "ু", "–": "ু", "~": "ূ",
    "ƒ": "ূ", "‚": "ূ", "„": "ৃ", "…": "ৃ", "Š": "ৗ",
    // A stray backslash is a Bijoy typing artefact with no glyph.
    "\\": "",
};

/** Vowel signs typed before the consonant cluster they follow in Unicode. */
const PRE_BASE: Readonly<Record<string, string>> = {
    w: "ি", // ি
    "†": "ে", // ে
    "‡": "ে",
    "ˆ": "ৈ", // ৈ
    "‰": "ৈ",
};
const REPH = "©";

// Private-use markers that hold a glyph's place until it is reordered.
const MARK_I = "";
const MARK_E = "";
const MARK_AI = "";
const MARK_REPH = "";
const MARK_FOR: Readonly<Record<string, string>> = {
    "ি": MARK_I,
    "ে": MARK_E,
    "ৈ": MARK_AI,
};
const SIGN_FOR: Readonly<Record<string, string>> = {
    [MARK_I]: "ি",
    [MARK_E]: "ে",
    [MARK_AI]: "ৈ",
};

const CONSONANT = `${BENGALI_CONSONANT}\\u09BC?`;
/** A consonant with any conjoined consonants (hasant without ZWNJ joins). */
const CLUSTER = `${CONSONANT}(?:\\u09CD(?!\\u200C)${CONSONANT})*`;
const POST_SIGNS = "[\\u09BE-\\u09C4\\u09D7\\u0981-\\u0983]*";

const REPH_PATTERN = new RegExp(`(${CLUSTER})(${POST_SIGNS})${MARK_REPH}`, "g");
const PRE_BASE_PATTERN = new RegExp(
    `([${MARK_I}${MARK_E}${MARK_AI}])(\\u0981?)(${CLUSTER})`,
    "g",
);

/**
 * Convert Bijoy-encoded text to Unicode Bangla. Every character is read as a
 * Bijoy glyph, so only pass text known to be Bijoy (a run in an MJ font, or
 * text `looksLikeBijoy` accepts); ordinary English would be garbled.
 */
export function bijoyToUnicode(input: string): string {
    let out = "";
    for (const ch of input) {
        const pre = PRE_BASE[ch];
        if (pre) out += MARK_FOR[pre];
        else if (ch === REPH) out += MARK_REPH;
        else out += GLYPHS[ch] ?? ch;
    }
    out = out
        // A half form followed by a phala leaves two hasants.
        .replace(/্{2,}/g, "্")
        // Reph is typed after the cluster (and any vowel sign) it sits on.
        .replace(REPH_PATTERN, "র্$1$2")
        .replace(new RegExp(MARK_REPH, "g"), "র্")
        // ি ে ৈ are typed before the cluster they follow; chandrabindu typed
        // between them stays after the vowel sign.
        .replace(PRE_BASE_PATTERN, (_m, mark: string, candra: string, cluster: string) =>
            `${cluster}${SIGN_FOR[mark]}${candra}`,
        )
        .replace(/[-]/g, (mark) => SIGN_FOR[mark])
        // ে + া and ে + ৗ are the two halves of ো and ৌ.
        .replace(/ো/g, "ো")
        .replace(/ৌ/g, "ৌ")
        // অ + া is আ.
        .replace(/অা/g, "আ");
    return normalizeBangla(out);
}

/**
 * How a font encodes Bangla:
 * - "bijoy": an ANSI font drawn with the Bijoy layout. The "MJ" families
 *   (SutonnyMJ, SushreeMJ, ...) are certain.
 * - "legacy": another ANSI family (AdarshaLipi) whose text is converted only
 *   when it also reads as Bijoy, since its layout is not certain to match.
 * - "unicode": everything else, including the "OMJ" families: SutonnyOMJ is
 *   the Unicode (OpenType) release of Sutonny, not a Bijoy font.
 */
export type BanglaFontEncoding = "bijoy" | "legacy" | "unicode";

export function banglaFontEncoding(font: string | null | undefined): BanglaFontEncoding {
    if (!font) return "unicode";
    const name = font
        .replace(/^[A-Z]{6}\+/, "") // PDF subset prefix
        .replace(/[\s,_-]*(Bold|Italic|Regular|Normal|Expanded|Exp)*$/gi, "")
        .trim();
    if (/OMJ$/i.test(name) || /unicode/i.test(name)) return "unicode";
    if (/MJ$/i.test(name) || /\bMJ\b/i.test(name) || /^Bijoy/i.test(name)) return "bijoy";
    if (/^AdarshaLipi/i.test(name)) return "legacy";
    return "unicode";
}

/** Whether a font is certainly a Bijoy (ANSI) font: SutonnyMJ and the MJ family. */
export function isBijoyFontName(font: string | null | undefined): boolean {
    return banglaFontEncoding(font) === "bijoy";
}

// Glyph codes that ordinary English or European text almost never uses but
// Bijoy text uses constantly (vowel signs, phalas, half forms).
const SIGNATURE = /[†‡ˆ‰¨ª¯³÷µ¸»¼½¾š›¤˜™¦ŸŒœ‹]/g;
// Frequent Bijoy-encoded words: এবং, করা, করিয়া, হয়, আইন, ধারা, সরকার,
// জন্য, এই, না, তার, তাহার, বাংলা..., আদালত, তারিখ, চুক্তি.
const COMMON_WORD =
    /^(Ges|Kiv|Kwiqv|nq|AvBb|aviv|miKvi|Rb¨|GB|bv|Zvi|Zvnvi|evsjv\S*|Av`vjZ|ZvwiL|Pzw³\S*|nB‡e|Ki‡Z|‡_‡K|†_‡K|Av‡Q|D³|wZwb)$/;
const ENGLISH_WORD =
    /^(the|and|of|to|in|is|for|that|this|with|shall|be|by|on|as|or|any|such|which|are|at|from|an|not|act|section)$/i;

function signals(text: string) {
    const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
    const words = text.split(/[\s,.;:()]+/).filter(Boolean);
    // Bijoy types ি (w) before its consonant and আ as "Av", so words that
    // start with "w" + consonant or contain "Av" are telling.
    // On their own they also match English ("which", "Avenue"), so they only
    // ever support a Bijoy-only glyph code, never stand in for one.
    const typed = words.filter((w) => /^w[A-Za-z`_]/.test(w) || /Av/.test(w)).length;
    const signature = text.match(SIGNATURE)?.length ?? 0;
    const common = words.filter((w) => COMMON_WORD.test(w)).length;
    const english = words.filter((w) => ENGLISH_WORD.test(w)).length;
    return { letters, signature, typed, common, english, words: words.length };
}

/**
 * Whether a passage is Bijoy-encoded Bangla. Conservative: a passage with
 * any Unicode Bangla, or that reads as English, is never Bijoy; otherwise it
 * needs several Bijoy-only glyph codes or common Bijoy-encoded words.
 */
export function looksLikeBijoy(text: string): boolean {
    if (hasBengali(text)) return false;
    const s = signals(text);
    if (s.letters < 3) return false;
    if (s.english >= 2 || (s.words > 0 && s.english / s.words > 0.2)) return false;
    return (
        (s.signature >= 2 && s.signature / Math.max(1, s.letters) >= 0.02) ||
        s.common >= 2 ||
        (s.signature >= 1 && (s.common >= 1 || s.typed >= 2))
    );
}

/**
 * Whether text in a legacy ANSI font carries any sign of the Bijoy layout: a
 * Bijoy-only glyph code or a common Bijoy-encoded word, and no Unicode Bangla.
 */
export function hasBijoyGlyphs(text: string): boolean {
    if (hasBengali(text)) return false;
    const s = signals(text);
    return s.signature >= 1 || s.common >= 1;
}

/**
 * Convert the Bijoy passages of extracted text, line by line. When the text
 * as a whole is clearly Bijoy (a page of a Bijoy PDF), every line without
 * Unicode Bangla that does not read as English is converted, so short lines
 * such as "aviv 5" are not left behind; otherwise only lines that look like
 * Bijoy on their own are.
 */
export function convertBijoyPassages(text: string): string {
    if (!text) return text;
    const whole = signals(text);
    const wholeIsBijoy =
        !hasBengali(text) &&
        whole.signature >= 5 &&
        whole.english / Math.max(1, whole.words) < 0.1;
    let changed = false;
    const lines = text.split("\n").map((line) => {
        const convert = wholeIsBijoy
            ? !hasBengali(line) &&
              /[A-Za-z]/.test(line) &&
              signals(line).english < 2 &&
              !/^\[Page \d+( form fields)?\]$/.test(line.trim())
            : looksLikeBijoy(line);
        if (!convert) return line;
        changed = true;
        return bijoyToUnicode(line);
    });
    return changed ? lines.join("\n") : text;
}
