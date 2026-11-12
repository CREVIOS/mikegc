// Repair Bangla text that a PDF stored in visual (glyph) order.
//
// A PDF draws the vowel signs ি ে ৈ to the left of their consonant, and many
// PDFs (including most saved from Word) record the glyphs in that drawing
// order. Text extracted from them reads "িক" for কি and "েকা" for কো, which
// the model misreads and which never matches a quote or a search. In correct
// Unicode those signs always follow a consonant, so a page where they mostly
// do not is in visual order and is reordered; a page in logical order is
// left alone.

import { BENGALI_CONSONANT, normalizeBangla } from "./normalize";

const PRE_BASE_SIGNS = "\\u09BF\\u09C7\\u09C8";
const CONSONANT = `${BENGALI_CONSONANT}\\u09BC?`;
const CLUSTER = `${CONSONANT}(?:\\u09CD(?!\\u200C)${CONSONANT})*`;

const SIGN = new RegExp(`[${PRE_BASE_SIGNS}]`, "g");
/** A pre-base sign that follows a consonant or nukta, as logical order has it. */
const SIGN_AFTER_CONSONANT = new RegExp(
    `(?:${BENGALI_CONSONANT}|\\u09BC)[${PRE_BASE_SIGNS}]`,
    "g",
);
const REORDER = new RegExp(`([${PRE_BASE_SIGNS}])(\\u0981?)(${CLUSTER})`, "g");

/**
 * Whether Bangla text is in visual order: it has several pre-base vowel
 * signs and a large share of them do not follow a consonant.
 */
export function isVisualOrderBangla(text: string): boolean {
    const nfc = text.normalize("NFC");
    const signs = nfc.match(SIGN)?.length ?? 0;
    if (signs < 2) return false;
    const attached = nfc.match(SIGN_AFTER_CONSONANT)?.length ?? 0;
    const orphans = signs - attached;
    return orphans >= 2 && orphans / signs >= 0.3;
}

/** Move each pre-base sign after the cluster it precedes, then rejoin ো and ৌ. */
export function reorderVisualBangla(text: string): string {
    return normalizeBangla(
        text
            .normalize("NFC")
            .replace(REORDER, (_m, sign: string, candra: string, cluster: string) =>
                `${cluster}${sign}${candra}`,
            )
            .replace(/ো/g, "ো")
            .replace(/ৌ/g, "ৌ"),
    );
}

/** Reorder text only when it is in visual order. */
export function repairVisualOrderBangla(text: string): string {
    return isVisualOrderBangla(text) ? reorderVisualBangla(text) : text;
}
