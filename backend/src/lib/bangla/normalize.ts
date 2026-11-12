// Unicode hygiene for Bangla (Bengali) text.
//
// The same Bangla word can be spelled with different code points: য় is
// U+09DF or য + nukta, ো is U+09CB or ে + া, and khanda-ta is U+09CE or
// ত + hasant + ZWJ. Visually identical text then fails to match in search,
// quote verification and find-in-document. Everything Spectre stores or
// compares goes through `normalizeBangla` so both sides use one spelling.

/** Any code point in the Bengali block. */
export const BENGALI_CHAR = /[ঀ-৿]/;

/** Bengali consonants (including ড় ঢ় য় and khanda-ta). */
export const BENGALI_CONSONANT = "[\\u0995-\\u09B9\\u09CE\\u09DC\\u09DD\\u09DF]";

/** Whether the text contains any Bengali-script character. */
export function hasBengali(text: string): boolean {
    return BENGALI_CHAR.test(text);
}

/**
 * NFC, plus the one legacy spelling NFC leaves alone: khanda-ta written as
 * ত + hasant + ZWJ becomes U+09CE. Text without Bengali is only NFC'd.
 */
export function normalizeBangla(text: string): string {
    const nfc = text.normalize("NFC");
    if (!hasBengali(nfc)) return nfc;
    return nfc.replace(/ত্‍/g, "ৎ");
}

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";

/** Bangla digits (০-৯) as ASCII digits; other characters unchanged. */
export function banglaDigitsToAscii(text: string): string {
    return text.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/** ASCII digits as Bangla digits; other characters unchanged. */
export function asciiDigitsToBangla(text: string): string {
    return text.replace(/[0-9]/g, (d) => BANGLA_DIGITS[Number(d)]);
}
