// Is a PDF page's text layer worth reading?
//
// Bangladeshi court and gazette PDFs often carry a text layer that is not the
// page's text: Unicode Bangla re-encoded into junk code points ("এনািজȟ ǯর̶"),
// or an English OCR layer laid over a Bangla scan ("fAvta qeges eftE").
// Passing that to the model as the document's text is worse than passing
// nothing, so such a page is treated like a scan: transcribed by OCR where
// OCR is set up, and otherwise reported as unreadable.
//
// Run this after Bijoy conversion and visual-order repair, so legacy text
// that can be repaired is not thrown away.

import { hasBengali } from "./normalize";

// Latin Extended-B, IPA, spacing modifiers, combining diacritics, private
// use, and the replacement character: none belong inside Bangla text.
const JUNK_IN_BANGLA = /[ƀ-˿̀-ͯ-�]/g;
const JUNK_ANYWHERE = /[-�]/g;
const BENGALI_LETTER = /[অ-হৎড়-য়]/g;
const ENGLISH_WORD =
    /^(the|and|of|to|in|is|for|that|this|with|shall|be|by|on|as|or|any|such|which|are|at|from|an|not|act|section|court|order|date|no|case|petition|division|high|supreme|government|bangladesh|dhaka|page|vs|versus|mr|md|ltd|limited)$/i;

export type TextLayerQuality = "readable" | "garbled";

/** Whether a page's extracted text is real text or a garbled layer. */
export function textLayerQuality(pageText: string): TextLayerQuality {
    const text = pageText.replace(/^\[Page \d+[^\]]*\]\s*/gm, "");
    const visible = text.replace(/\s+/g, "");
    if (visible.length < 20) return "readable";

    // Private-use or replacement characters: undecodable glyphs.
    const undecodable = text.match(JUNK_ANYWHERE)?.length ?? 0;
    if (undecodable / visible.length >= 0.1) return "garbled";

    // Bangla mixed with code points that never occur in Bangla words.
    if (hasBengali(text)) {
        const letters = text.match(BENGALI_LETTER)?.length ?? 0;
        const junk = text.match(JUNK_IN_BANGLA)?.length ?? 0;
        return letters > 0 && junk / letters >= 0.05 ? "garbled" : "readable";
    }

    // Latin text that is not language: almost no English words, and many
    // words with capitals inside them, as an English OCR engine produces
    // when it reads a Bangla scan.
    const words = text.split(/[\s,.;:()[\]"'|]+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.length < 15) return "readable";
    const english = words.filter((w) => ENGLISH_WORD.test(w)).length;
    const innerCapitals = words.filter((w) => /[a-z][A-Z]/.test(w)).length;
    return english / words.length < 0.05 && innerCapitals / words.length >= 0.2
        ? "garbled"
        : "readable";
}
