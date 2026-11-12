/**
 * The letters, combining marks and digits of a string, in any script, for
 * matching a quote against rendered document text while ignoring spacing,
 * punctuation and case. Combining marks matter: Bangla vowel signs and the
 * hasanta are marks, so dropping them (or keeping only a-z) would make every
 * Bangla quote unmatchable. Each character is canonically decomposed, so a
 * precomposed letter (Bangla য় U+09DF, ো, or é) matches its decomposed
 * spelling. Zero-width joiners only choose a conjunct's shape and are ignored.
 */
const LETTER = /[\p{L}\p{M}\p{N}]/u;

/** The comparable units one character contributes ("" for punctuation). */
function letterUnits(ch: string): string {
    let units = "";
    for (const part of ch.normalize("NFD").toLowerCase()) {
        if (LETTER.test(part)) units += part;
    }
    return units;
}

/** The comparable form of a whole string. */
export function onlyLetters(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) out += letterUnits(s[i]);
    return out;
}

/**
 * The index in `original` of the character that contributes comparable unit
 * `strippedPos` of `onlyLetters(original)`; `original.length` past the end.
 */
export function strippedPosToOriginal(
    original: string,
    strippedPos: number,
): number {
    let count = 0;
    for (let i = 0; i < original.length; i++) {
        count += letterUnits(original[i]).length;
        if (count > strippedPos) return i;
    }
    return original.length;
}
