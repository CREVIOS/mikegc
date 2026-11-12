// Bangla text handling for documents Spectre reads: Unicode normalisation,
// legacy Bijoy conversion and repair of PDF text in visual order.
export {
    BENGALI_CHAR,
    asciiDigitsToBangla,
    banglaDigitsToAscii,
    hasBengali,
    normalizeBangla,
} from "./normalize";
export {
    bijoyToUnicode,
    convertBijoyPassages,
    isBijoyFontName,
    looksLikeBijoy,
} from "./bijoy";
export {
    isVisualOrderBangla,
    reorderVisualBangla,
    repairVisualOrderBangla,
} from "./visualOrder";

import { convertBijoyPassages } from "./bijoy";
import { normalizeBangla } from "./normalize";
import { repairVisualOrderBangla } from "./visualOrder";

/**
 * Make text extracted from a PDF page readable Bangla: convert Bijoy
 * passages, reorder visual-order vowel signs, and normalise to NFC. Text with
 * no Bangla (or Bijoy) in it comes back unchanged apart from NFC.
 */
export function readablePdfText(text: string): string {
    return normalizeBangla(repairVisualOrderBangla(convertBijoyPassages(text)));
}
export { BANGLA_LANGUAGE_TAG, DEFAULT_BANGLA_FONT, banglaDocumentFont } from "./fonts";
