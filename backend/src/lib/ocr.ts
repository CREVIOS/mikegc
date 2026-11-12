// OCR of PDF pages that have no usable text layer: scans, and pages whose
// text layer is garbled. Bangladeshi legal work runs on scanned certified
// copies, court orders and gazettes, mostly in Bangla.
//
// Pages are rendered with pdf.js and transcribed by a vision model with an
// instruction to transcribe exactly. Classic OCR is a poor fit: Tesseract,
// Azure and AWS read Bangla badly or not at all, while frontier vision models
// reach single-digit character error rates on printed Bangla. Gemini leads
// published Bangla benchmarks, so it is preferred when a Gemini key is set;
// otherwise Anthropic, then OpenAI. SPECTRE_OCR_MODEL chooses explicitly.
//
// OCR runs on the deployment's own keys (like web search), at most
// SPECTRE_OCR_MAX_PAGES pages per document, and its results are cached per
// page content hash so a document read twice is transcribed once. Every
// transcribed page says so, because OCR text must be checked against the
// original before it is quoted. Handwritten pages (khatians, deeds) are
// beyond any current model and are flagged rather than trusted.

import { createHash } from "crypto";
import { completeVision } from "./llm";
import type { UserApiKeys } from "./llm/types";
import { normalizeBangla } from "./bangla/normalize";
import { safeError } from "./safeError";
import { environmentKey } from "./envKey";

const DEFAULT_MAX_PAGES = 40;
const RENDER_SCALE = 2; // about 144 dpi: legible Bangla without huge images
const CONCURRENCY = 3;
const CACHE_MAX = 500;

export const OCR_PAGE_NOTE =
    "[Transcribed by OCR from the page image. Check it against the original before quoting it.]";

export const OCR_SYSTEM_PROMPT = `You transcribe scanned legal documents from Bangladesh: court orders, judgments, gazettes, deeds, khatians, notices and contracts, in Bangla, English or both.
- Transcribe exactly what is printed or written, in reading order. Do not translate, summarise, correct, complete or explain anything.
- Write Bangla in Unicode Bangla, keeping its own spelling, the dari (।) and Bangla digits as printed. Write English as printed.
- Keep line breaks between paragraphs, numbered paragraphs and list items. Write a table as one row per line with cells separated by " | ".
- Mark text you cannot read as [illegible], and handwriting you are unsure of as [handwriting, uncertain: …].
- Include stamps, seals, signatures and marginal notes as [stamp: …], [seal], [signature], [note: …] where they carry text.
- Output only the transcription. If the page is blank, output [blank page].`;

export type OcrConfig = { model: string; apiKeys: UserApiKeys; maxPages: number };

/**
 * The OCR set-up from the deployment's environment, or null when OCR is off
 * (SPECTRE_OCR_ENABLED=false) or no vision-capable key is configured.
 */
export function ocrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig | null {
    if (env.SPECTRE_OCR_ENABLED?.trim().toLowerCase() === "false") return null;
    const key = (name: string) => environmentKey(name, env);
    const apiKeys: UserApiKeys = {
        gemini: key("GEMINI_API_KEY"),
        claude: key("ANTHROPIC_API_KEY"),
        openai: key("OPENAI_API_KEY"),
    };
    const maxPages = Math.max(1, Math.min(500, Number(env.SPECTRE_OCR_MAX_PAGES) || DEFAULT_MAX_PAGES));
    const configured = env.SPECTRE_OCR_MODEL?.trim();
    if (configured) return { model: configured, apiKeys, maxPages };
    if (apiKeys.gemini) return { model: "gemini-3.8-flash", apiKeys, maxPages };
    if (apiKeys.claude) return { model: "claude-sonnet-5-5", apiKeys, maxPages };
    if (apiKeys.openai) return { model: "gpt-6.1-sol", apiKeys, maxPages };
    return null;
}

const cache = new Map<string, string>();

/** Test hook. */
export function clearOcrCache() {
    cache.clear();
}

type PdfDocument = {
    getPage: (n: number) => Promise<{
        getViewport: (opts: { scale: number }) => { width: number; height: number };
        render: (opts: unknown) => { promise: Promise<void> };
    }>;
    canvasFactory: {
        create: (w: number, h: number) => { canvas: { toBuffer: (type: string) => Buffer }; context: unknown };
    };
};

/** A page rendered to PNG. */
export async function renderPdfPage(doc: PdfDocument, pageNumber: number): Promise<Buffer> {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const { canvas, context } = doc.canvasFactory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
    );
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return canvas.toBuffer("image/png");
}

export type Transcribe = (png: Buffer) => Promise<string>;

/** Transcribe one page image with the configured vision model. */
export function visionTranscriber(config: OcrConfig, signal?: AbortSignal): Transcribe {
    return async (png) => {
        return completeVision({
            model: config.model,
            systemPrompt: OCR_SYSTEM_PROMPT,
            prompt: "Transcribe this page.",
            images: [{ data: new Uint8Array(png), mediaType: "image/png" }],
            maxTokens: 8000,
            abortSignal: signal,
            apiKeys: config.apiKeys,
        });
    };
}

/**
 * Transcribe the given pages (1-based) of an open PDF. Pages beyond the
 * limit, and pages that fail, are left out of the result, so the caller
 * keeps reporting them as unreadable.
 */
export async function ocrPdfPages(
    doc: PdfDocument,
    pages: number[],
    options: { maxPages: number; transcribe: Transcribe },
): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const queue = pages.slice(0, options.maxPages);
    const worker = async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            try {
                const png = await renderPdfPage(doc, next);
                const key = createHash("sha256").update(png).digest("hex");
                let text = cache.get(key);
                if (text === undefined) {
                    text = normalizeBangla((await options.transcribe(png)).trim());
                    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
                    cache.set(key, text);
                }
                if (text) out.set(next, text);
            } catch (error) {
                console.warn("[ocr] page could not be transcribed", {
                    page: next,
                    error: safeError(error),
                });
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out;
}
