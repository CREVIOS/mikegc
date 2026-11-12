// The font generated Word and PowerPoint files use for Bangla.
//
// Word and PowerPoint draw Bangla with a run's complex-script font (w:cs,
// a:cs), not the Latin one, so a document whose runs only name Times New
// Roman falls back to whatever the reader's computer picks. Spectre names a
// Bangla font explicitly. Nirmala UI ships with every Windows since 8 and
// covers Bangla well, so documents look right on the computers most
// Bangladeshi offices use; a deployment can choose another Unicode font,
// such as Nikosh, Kalpurush or SolaimanLipi, with SPECTRE_BANGLA_FONT.
// Never name a Bijoy ("MJ") font here: those are not Unicode fonts.

import { isBijoyFontName } from "./bijoy";

export const DEFAULT_BANGLA_FONT = "Nirmala UI";

/** The Unicode Bangla font for generated documents. */
export function banglaDocumentFont(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.SPECTRE_BANGLA_FONT?.trim();
    if (!configured || isBijoyFontName(configured) || /["<>&]/.test(configured)) {
        return DEFAULT_BANGLA_FONT;
    }
    return configured;
}

/** The language tag for Bangla text in generated documents. */
export const BANGLA_LANGUAGE_TAG = "bn-BD";
