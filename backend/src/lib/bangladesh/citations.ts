// Bangladeshi law-report citations: find them, and tell which ones an answer
// did not take from a source it read.
//
// Most Bangladeshi reports (DLR, BLD, BLC, MLR, ADC and others) are in print
// or paid databases, so a model can produce a citation that looks right and
// is not. An intern's memo with 13 of 15 cases invented is the story every
// Dhaka firm has heard. The answer is not to trust the model's word: an
// authority counts as checked only if it appears in a document, statute page
// or web page read for the answer, or in what the user wrote.
//
// Forms recognised (spacing, case and an optional leading year vary):
//   56 DLR (AD) 1      (1973) 25 DLR (HCD) 335      17 BLD (AD) 1
//   15 BLC (AD) 45     5 MLR (AD) 1                 (2015) 4 LNJ (AD) 123
//   15 SCOB [2021] AD 1                              22 DLR (SC) 10

const REPORTERS = "DLR|BLD|BLC|MLR|ADC|ALR|BLT|LNJ|CLR|BCR|LM|LG|MLR";
const DIVISIONS = "AD|HCD|HC|SC|Dhaka|PC|WP";

const REPORT_CITATION = new RegExp(
    String.raw`(?:\((\d{4})\)\s*)?\b(\d{1,3})\s+(${REPORTERS})\s*\(\s*(${DIVISIONS})\s*\)\s*(\d{1,4})\b`,
    "gi",
);
const SCOB_CITATION = new RegExp(
    String.raw`\b(\d{1,2})\s+SCOB\s*\[\s*(\d{4})\s*\]\s*(AD|HCD)\s*(\d{1,4})\b`,
    "gi",
);

export type BangladeshCaseCitation = {
    /** The citation as written. */
    text: string;
    /** A canonical form for comparison: "56 DLR (AD) 1", "15 SCOB [2021] AD 1". */
    key: string;
};

/** Every Bangladeshi law-report citation in a text, once each, in order. */
export function findBangladeshCaseCitations(text: string): BangladeshCaseCitation[] {
    const found = new Map<string, BangladeshCaseCitation>();
    for (const match of text.matchAll(REPORT_CITATION)) {
        const [, , volume, reporter, division, page] = match;
        const key = `${Number(volume)} ${reporter.toUpperCase()} (${canonicalDivision(division)}) ${Number(page)}`;
        if (!found.has(key)) found.set(key, { text: match[0].trim(), key });
    }
    for (const match of text.matchAll(SCOB_CITATION)) {
        const [, volume, year, division, page] = match;
        const key = `${Number(volume)} SCOB [${year}] ${division.toUpperCase()} ${Number(page)}`;
        if (!found.has(key)) found.set(key, { text: match[0].trim(), key });
    }
    return [...found.values()];
}

function canonicalDivision(division: string): string {
    const upper = division.toUpperCase();
    return upper === "DHAKA" ? "Dhaka" : upper;
}

/**
 * The citations in `answer` that none of `sources` contains, compared in
 * canonical form, so "56 DLR(AD)1" in a judgment matches "56 DLR (AD) 1" in
 * the answer.
 */
export function unverifiedCaseCitations(
    answer: string,
    sources: readonly string[],
): BangladeshCaseCitation[] {
    const cited = findBangladeshCaseCitations(answer);
    if (!cited.length) return [];
    const available = new Set<string>();
    for (const source of sources) {
        for (const citation of findBangladeshCaseCitations(source)) available.add(citation.key);
    }
    return cited.filter((citation) => !available.has(citation.key));
}
