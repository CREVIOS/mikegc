import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfTextForModel, GARBLED_PAGE_NOTE } from "../pdfText";
import { clearOcrCache, OCR_PAGE_NOTE, ocrConfig } from "../ocr";

/** A one-page PDF with no text layer, as a scan without OCR would be. */
function blankPdf(): ArrayBuffer {
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>",
        "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((object, i) => {
        offsets.push(body.length);
        body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(body).buffer as ArrayBuffer;
}

const config = { model: "gemini-3.8-flash", apiKeys: {}, maxPages: 5 };

describe("OCR of unreadable PDF pages", () => {
    beforeEach(() => clearOcrCache());

    it("transcribes a page with no text layer and says it was OCR'd", async () => {
        const transcribe = vi.fn(async (png: Buffer) => {
            expect(png.subarray(1, 4).toString()).toBe("PNG");
            return "সুপ্রীম কোর্ট অব বাংলাদেশ\nহাইকোর্ট বিভাগ";
        });
        const text = await extractPdfTextForModel(blankPdf(), { config, transcribe });
        expect(transcribe).toHaveBeenCalledOnce();
        expect(text).toBe(`[Page 1]\n${OCR_PAGE_NOTE}\n${"সুপ্রীম কোর্ট অব বাংলাদেশ\nহাইকোর্ট বিভাগ".normalize("NFC")}`);
    });

    it("transcribes the same page once, however often it is read", async () => {
        const transcribe = vi.fn(async () => "text");
        await extractPdfTextForModel(blankPdf(), { config, transcribe });
        await extractPdfTextForModel(blankPdf(), { config, transcribe });
        expect(transcribe).toHaveBeenCalledOnce();
    });

    it("falls back to the no-text notice when OCR is off or fails", async () => {
        const off = await extractPdfTextForModel(blankPdf(), { config: null });
        expect(off).toContain("has no text layer");
        const failing = await extractPdfTextForModel(blankPdf(), {
            config,
            transcribe: async () => {
                throw new Error("model unavailable");
            },
        });
        expect(failing).toContain("has no text layer");
        expect(GARBLED_PAGE_NOTE).toContain("needs OCR");
    });
});

describe("OCR configuration", () => {
    it("prefers Gemini for Bangla, then Anthropic, then OpenAI, and can be turned off", () => {
        expect(ocrConfig({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" })?.model).toBe("gemini-3.8-flash");
        expect(ocrConfig({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })?.model).toBe("claude-sonnet-5-5");
        expect(ocrConfig({ OPENAI_API_KEY: "o" })?.model).toBe("gpt-6.1-sol");
        expect(ocrConfig({ OPENAI_API_KEY: "o", SPECTRE_OCR_MODEL: "gemini-3.1-pro-preview" })?.model).toBe("gemini-3.1-pro-preview");
        expect(ocrConfig({ OPENAI_API_KEY: "o", SPECTRE_OCR_ENABLED: "false" })).toBeNull();
        // Placeholder keys from .env.example do not count.
        expect(ocrConfig({ OPENAI_API_KEY: "your-openai-key" })).toBeNull();
        expect(ocrConfig({})).toBeNull();
    });
});
