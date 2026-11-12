import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import {
    buildPaperBook,
    PAPER_BOOK_PAGE,
    paperBookIndexDocx,
    type RenderIndex,
} from "../paperBook";

/** An A4 PDF of `pages` pages, each saying which document and page it is. */
async function a4(label: string, pages: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`${label} page ${i}`, { x: 72, y: 760, font, size: 14 });
    return doc.save();
}

/** Stands in for LibreOffice: a one-page 13 x 8 inch index. */
const renderIndex: RenderIndex = async () => {
    const doc = await PDFDocument.create();
    doc.addPage([PAPER_BOOK_PAGE.width, PAPER_BOOK_PAGE.height]);
    return Buffer.from(await doc.save());
};

async function pageText(pdf: Uint8Array, pageNumber: number): Promise<string> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const doc = await (pdfjs as { getDocument: (o: unknown) => { promise: Promise<any> } }).getDocument({ data: pdf.slice() }).promise;
    const content = await (await doc.getPage(pageNumber)).getTextContent();
    return content.items.map((item: { str: string }) => item.str).join(" ");
}

describe("HCD paper book", () => {
    it("puts Part I before Part II, numbers pages continuously after the index, and indexes each entry", async () => {
        const book = await buildPaperBook({
            causeTitle: "First Appeal No. 252 of 2025",
            items: [
                { description: "Exhibit-1: Sale deed No. 4512 dated 03.02.1998", part: "II", pdf: await a4("Deed", 3) },
                { description: "Memorandum of appeal", part: "I", pdf: await a4("Memo", 2) },
                { description: "Certified copy of the judgment and decree dated 01.12.2025", part: "I", pdf: await a4("Judgment", 4) },
            ],
            renderIndex,
        });
        expect(book.entries).toEqual([
            { serial: 1, description: "Memorandum of appeal", part: "I", firstPage: 1, lastPage: 2 },
            { serial: 2, description: "Certified copy of the judgment and decree dated 01.12.2025", part: "I", firstPage: 3, lastPage: 6 },
            { serial: 3, description: "Exhibit-1: Sale deed No. 4512 dated 03.02.1998", part: "II", firstPage: 7, lastPage: 9 },
        ]);
        expect(book.pageCount).toBe(9);
        expect(book.needsHardboardCover).toBe(false);

        const pdf = await PDFDocument.load(book.pdf);
        expect(pdf.getPageCount()).toBe(book.indexPages + 9);
        for (const page of pdf.getPages()) {
            expect(page.getSize()).toEqual({ width: 576, height: 936 });
        }
        // The first content page is the memorandum, numbered 1; the deed starts at 7.
        expect(await pageText(book.pdf, 2)).toContain("Memo page 1");
        expect(await pageText(book.pdf, 2)).toMatch(/\b1\b/);
        expect(await pageText(book.pdf, book.indexPages + 7)).toContain("Deed page 1");
        expect(await pageText(book.pdf, book.indexPages + 7)).toMatch(/\b7\b/);
        // Bookmarks: the index and each entry.
        expect(pdf.catalog.get(PDFName.of("Outlines"))).toBeDefined();
    });

    it("flags a book over 300 pages for hardboard covers", async () => {
        const book = await buildPaperBook({
            causeTitle: "Civil Revision No. 1 of 2026",
            items: [{ description: "Lower court records", part: "I", pdf: await a4("LCR", 301) }],
            renderIndex,
        });
        expect(book.needsHardboardCover).toBe(true);
    });

    it("lays the index out to the Rule: 13 x 8 inch paper, the Rule's margins, double spacing, both Parts", async () => {
        const docx = await paperBookIndexDocx("Writ Petition No. 1434 of 2026", [
            { serial: 1, description: "আরজির সত্যায়িত অনুলিপি", part: "I", firstPage: 1, lastPage: 5 },
            { serial: 2, description: "Exhibit-A", part: "II", firstPage: 6, lastPage: 6 },
        ]);
        const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
        expect(xml).toContain('w:w="11520"'); // 8 inches
        expect(xml).toContain('w:h="18720"'); // 13 inches
        expect(xml).toMatch(/w:left="2880"/); // 2 inches
        expect(xml).toMatch(/w:right="2160"/); // 1.5 inches
        expect(xml).toMatch(/w:top="1440"/); // 1 inch
        expect(xml).toMatch(/w:bottom="2880"/); // 2 inches
        expect(xml).toContain('w:line="480"');
        expect(xml).toContain("PART-I (Documents other than exhibits)");
        expect(xml).toContain("PART-II (Exhibits)");
        expect(xml).toContain("আরজির সত্যায়িত অনুলিপি");
        expect(xml).toContain("1-5");
    });

    it("refuses an empty book", async () => {
        await expect(buildPaperBook({ causeTitle: "x", items: [], renderIndex })).rejects.toThrow(/at least one/);
    });
});
