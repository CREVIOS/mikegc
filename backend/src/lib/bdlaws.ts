// Laws of Bangladesh (bdlaws.minlaw.gov.bd): search and read Acts, Ordinances
// and President's Orders as the Legislative and Parliamentary Affairs Division
// publishes them.
//
// Shared kernel: the chat engine's bd_law tools call this. The site has no
// API, so this reads its HTML pages:
//   search.html?q=…            results in div.result (h3.r a, p snippet;
//                               class "repealed" marks a repealed law)
//   act-{id}.html               an Act's title, number, date and sections
//   act-{id}/section-{sid}.html one section: .txt-head and .txt-details
//   act-details-{id}.html       the whole Act, every section in turn
// `{id}` is the site's own id, not the Act's number (the Contract Act, 1872
// is act-26), and section ids are global across the site.
//
// The site labels its pages "charset=UTF-16" and sends UTF-16 big-endian
// bytes, which WHATWG's "utf-16" label would decode as little-endian, so the
// byte order is read from the body. Requests go only to this one host, with
// redirects refused, through the shared SSRF guard. Pages are cached for an
// hour per process to keep load on a government site low.

import { guardedFetch } from "./mcp/client";
import { normalizeBangla } from "./bangla";

export const BDLAWS_ORIGIN = "https://bdlaws.minlaw.gov.bd";
const BDLAWS_HOST = "bdlaws.minlaw.gov.bd";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;

/** Paths of the site that hold law text or search results. */
const READABLE_PATH =
    /^\/(?:act-(?:details-|print-)?\d+\.html|act-\d+\/(?:section|chapter|chapter-details|act-chapter-print|act-part-print)-\d+\.html|act-print-\d+\/section-print-\d+\.html|search\.html)$/;

export class BdLawsError extends Error {
    constructor(
        message: string,
        readonly code: "invalid_url" | "unavailable" | "not_found",
    ) {
        super(message);
        this.name = "BdLawsError";
    }
}

export type BdLawLanguage = "bn" | "en";

export type BdLawSearchResult = {
    title: string;
    url: string;
    snippet: string;
    repealed: boolean;
};

export type BdLawSearch = {
    query: string;
    total: number | null;
    results: BdLawSearchResult[];
};

export type BdLawSection = { label: string; url: string };

export type BdLawPage = {
    url: string;
    title: string;
    /** "ACT NO. IX OF 1872", "২০২৬ সনের ৬৩ নং আইন", ... */
    number: string | null;
    /** The date the law bears, as the site prints it. */
    date: string | null;
    repealed: boolean;
    /** The table of contents, on an Act's index page. */
    sections: BdLawSection[];
    /** Section headings and text, on a section or full-text page. */
    text: string;
    /** Amendment and substitution notes. */
    footnotes: string[];
};

type FetchLike = typeof fetch;
type Deps = { fetch?: FetchLike; now?: () => number; signal?: AbortSignal };

const cache = new Map<string, { at: number; html: string }>();

/** Test hook: forget cached pages. */
export function clearBdLawsCache() {
    cache.clear();
}

/**
 * A URL on the Laws of Bangladesh that holds law text, normalised, or null.
 * Accepts the site's own links and bare paths such as "/act-26.html".
 */
export function bdLawsUrl(raw: string, lang?: BdLawLanguage): string | null {
    let url: URL;
    try {
        url = new URL(raw.trim(), BDLAWS_ORIGIN);
    } catch {
        return null;
    }
    if (url.hostname !== BDLAWS_HOST) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!READABLE_PATH.test(url.pathname)) return null;
    const out = new URL(url.pathname, BDLAWS_ORIGIN);
    if (url.pathname === "/search.html") {
        const q = url.searchParams.get("q");
        if (!q) return null;
        out.searchParams.set("q", q);
        const page = url.searchParams.get("page");
        if (page && /^\d{1,3}$/.test(page)) out.searchParams.set("page", page);
    }
    const language = lang ?? url.searchParams.get("lang");
    if (language === "bn" || language === "en") out.searchParams.set("lang", language);
    return out.toString();
}

/**
 * Decode a bdlaws body. A UTF-16 label is honoured with the byte order the
 * body itself shows (BOM, else where the zero bytes of ASCII markup fall);
 * anything else is UTF-8.
 */
export function decodeBdLawsBody(bytes: Uint8Array, contentType: string | null): string {
    const label = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim().toLowerCase() ?? "";
    const bom16be = bytes[0] === 0xfe && bytes[1] === 0xff;
    const bom16le = bytes[0] === 0xff && bytes[1] === 0xfe;
    const sample = bytes.subarray(0, Math.min(bytes.length, 512));
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) {
            if (i % 2 === 0) evenZeros++;
            else oddZeros++;
        }
    }
    const looks16 = evenZeros + oddZeros > sample.length / 8;
    if (bom16be || bom16le || label.startsWith("utf-16") || looks16) {
        const littleEndian = bom16le || (!bom16be && oddZeros > evenZeros);
        const text = new TextDecoder(littleEndian ? "utf-16le" : "utf-16be").decode(bytes);
        return text.replace(/^\uFEFF/, "");
    }
    return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

async function fetchPage(url: string, deps: Deps): Promise<string> {
    const now = deps.now ?? Date.now;
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.html;

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
    const init: RequestInit = {
        redirect: "manual",
        signal,
        headers: {
            accept: "text/html",
            "accept-language": "bn-BD,bn;q=0.9,en;q=0.8",
            "user-agent": "SpectreLegalResearch/1.0 (+https://github.com/open-legal-products/mikegc)",
        },
    };
    let response: Response;
    try {
        response = deps.fetch
            ? await deps.fetch(url, init)
            : await guardedFetch(url, init, { label: "The Laws of Bangladesh website" });
    } catch (error) {
        if (deps.signal?.aborted) throw error;
        throw new BdLawsError("The Laws of Bangladesh website could not be reached.", "unavailable");
    }
    if (response.status === 404) {
        throw new BdLawsError("That page does not exist on the Laws of Bangladesh website.", "not_found");
    }
    if (!response.ok) {
        throw new BdLawsError(
            `The Laws of Bangladesh website answered with HTTP ${response.status}.`,
            "unavailable",
        );
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
        throw new BdLawsError("That page is too large to read.", "unavailable");
    }
    const html = decodeBdLawsBody(buffer, response.headers.get("content-type"));
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(url, { at: now(), html });
    return html;
}

type Doc = Awaited<ReturnType<typeof parse>>;

async function parse(html: string) {
    const { parseHTML } = await import("linkedom");
    return parseHTML(html).document;
}

/** Element text with whitespace collapsed, in NFC. */
function textOf(node: { textContent?: string | null } | null | undefined): string {
    return normalizeBangla((node?.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim());
}

function absolute(href: string | null | undefined): string | null {
    if (!href) return null;
    return bdLawsUrl(href.replace(/\?hl=\d+$/, ""));
}

/** Search the Laws of Bangladesh by text, in English or Bangla. */
export async function searchBdLaws(
    query: string,
    options: Deps & { page?: number; lang?: BdLawLanguage } = {},
): Promise<BdLawSearch> {
    const q = normalizeBangla(query.trim()).slice(0, 200);
    if (!q) throw new BdLawsError("A search query is required.", "invalid_url");
    const url = new URL("/search.html", BDLAWS_ORIGIN);
    url.searchParams.set("q", q);
    if (options.page && options.page > 1) url.searchParams.set("page", String(Math.min(options.page, 999)));
    if (options.lang) url.searchParams.set("lang", options.lang);
    const document = await parse(await fetchPage(url.toString(), options));
    const results: BdLawSearchResult[] = [];
    for (const result of Array.from(document.querySelectorAll("div.result"))) {
        const link = result.querySelector("h3 a");
        const href = absolute(link?.getAttribute("href"));
        if (!link || !href) continue;
        results.push({
            title: textOf(link),
            url: href,
            snippet: textOf(result.querySelector(".s p") ?? result.querySelector("p")),
            repealed: (result.getAttribute("class") ?? "").split(/\s+/).includes("repealed"),
        });
    }
    const counter = textOf(document.querySelector(".pagination"));
    const total = /of\s+([\d,]+)/i.exec(counter)?.[1];
    return { query: q, total: total ? Number(total.replace(/,/g, "")) : null, results };
}

function pageTitle(document: Doc): string {
    const heading = document.querySelector(".bg-act-section h3");
    if (heading) {
        // The heading carries footnote markers in <sup>; drop them.
        for (const sup of Array.from(heading.querySelectorAll("sup"))) sup.remove();
        const title = textOf(heading);
        if (title) return title;
    }
    return textOf(document.querySelector("title")).split("|")[0].trim();
}

/** Read an Act's index, a section or a whole Act from the Laws of Bangladesh. */
export async function readBdLaw(
    rawUrl: string,
    options: Deps & { lang?: BdLawLanguage } = {},
): Promise<BdLawPage> {
    const url = bdLawsUrl(rawUrl, options.lang);
    if (!url || new URL(url).pathname === "/search.html") {
        throw new BdLawsError(
            "Only Act, section and chapter pages on bdlaws.minlaw.gov.bd can be read.",
            "invalid_url",
        );
    }
    const document = await parse(await fetchPage(url, options));
    const title = pageTitle(document);
    const number = textOf(document.querySelector(".bg-act-section h4")).replace(/^\(\s*|\s*\)$/g, "") || null;
    const date = textOf(document.querySelector(".publish-date")).replace(/^\[\s*|\s*\]$/g, "") || null;
    const bodyText = textOf(document.querySelector("body"));
    const repealed =
        /\brepealed\b/i.test(textOf(document.querySelector(".bg-act-section"))) ||
        /রহিত করা হইয়াছে|রহিত হইয়াছে/.test(bodyText.slice(0, 4000));

    const sections: BdLawSection[] = [];
    for (const link of Array.from(document.querySelectorAll(".act-section-name a"))) {
        const href = absolute(link.getAttribute("href"));
        if (href) sections.push({ label: textOf(link), url: href });
    }

    const parts: string[] = [];
    const preamble = textOf(document.querySelector(".preamble-content .col-md-10"));
    if (preamble) parts.push(preamble);
    for (const chapter of Array.from(document.querySelectorAll(".lineremoves"))) {
        const chapterName = textOf(chapter.querySelector(".act-chapter-name"));
        if (chapterName) parts.push(chapterName);
        const heads = Array.from(chapter.querySelectorAll(".txt-head"));
        const details = Array.from(chapter.querySelectorAll(".txt-details"));
        for (let i = 0; i < Math.max(heads.length, details.length); i++) {
            const head = textOf(heads[i]);
            const detail = textOf(details[i]);
            parts.push([head, detail].filter(Boolean).join("\n"));
        }
    }
    const footnotes = Array.from(document.querySelectorAll(".footnoteList"))
        .map((note) => textOf(note))
        .filter(Boolean);

    if (!title && !sections.length && !parts.length) {
        throw new BdLawsError("That page has no law text.", "not_found");
    }
    return { url, title, number, date, repealed, sections, text: parts.join("\n\n"), footnotes };
}
