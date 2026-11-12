// Paper books for the High Court Division of the Supreme Court of Bangladesh.
//
// The High Court Division Rules (Chapter VIII, as amended by the Gazette of
// 21 November 2012) require paper books on paper of at least 13 x 8 inches,
// with margins of 2 inches left, 1.5 inches right, 1 inch top and 2 inches
// bottom, double-spaced, with a serial-numbered index of contents and page
// numbers, the contents starting immediately after the index and divided into
// Part I (documents other than exhibits) and Part II (exhibits), and with
// hardboard covers when the book exceeds 300 pages.
//
// This assembles one PDF: the index (rendered by LibreOffice, so Bangla
// descriptions are shaped correctly), then each document's pages, Part I
// before Part II, each placed on a 13 x 8 inch page inside the Rule's margins
// and numbered continuously from 1, with a bookmark for every entry.

import type { PDFDocument as PdfLibDocument, PDFRef } from "pdf-lib";
import { banglaDocumentFont } from "./bangla/fonts";

const INCH = 72;
export const PAPER_BOOK_PAGE = { width: 8 * INCH, height: 13 * INCH };
export const PAPER_BOOK_MARGINS = { left: 2 * INCH, right: 1.5 * INCH, top: 1 * INCH, bottom: 2 * INCH };
export const HARDBOARD_COVER_PAGES = 300;

export type PaperBookPart = "I" | "II";

export type PaperBookItem = {
    /** As it should read in the index, e.g. "Certified copy of the judgment and decree dated 01.12.2025". */
    description: string;
    part: PaperBookPart;
    /** The document as a PDF. */
    pdf: Uint8Array;
};

export type PaperBookEntry = {
    serial: number;
    description: string;
    part: PaperBookPart;
    firstPage: number;
    lastPage: number;
};

export type PaperBook = {
    pdf: Uint8Array;
    entries: PaperBookEntry[];
    /** Numbered pages, index excluded. */
    pageCount: number;
    indexPages: number;
    needsHardboardCover: boolean;
};

/** Turns an index .docx into a PDF (LibreOffice in production). */
export type RenderIndex = (docx: Buffer) => Promise<Buffer>;

/** The index as a Word document laid out to the Rule. */
export async function paperBookIndexDocx(causeTitle: string, entries: PaperBookEntry[]): Promise<Buffer> {
    const d = await import("docx");
    const font = { ascii: "Times New Roman", hAnsi: "Times New Roman", cs: banglaDocumentFont() };
    const run = (text: string, bold = false) => new d.TextRun({ text, bold, font, size: 24, sizeComplexScript: 24 });
    const twips = (inches: number) => Math.round(inches * 1440);
    const cell = (text: string, width: number, bold = false, align: (typeof d.AlignmentType)[keyof typeof d.AlignmentType] = d.AlignmentType.LEFT) =>
        new d.TableCell({
            width: { size: width, type: d.WidthType.PERCENTAGE },
            children: [new d.Paragraph({ alignment: align, spacing: { line: 480 }, children: [run(text, bold)] })],
        });
    const rows = [
        new d.TableRow({
            tableHeader: true,
            children: [cell("Sl. No.", 12, true, d.AlignmentType.CENTER), cell("Description of documents", 66, true), cell("Pages", 22, true, d.AlignmentType.CENTER)],
        }),
    ];
    for (const part of ["I", "II"] as const) {
        const inPart = entries.filter((e) => e.part === part);
        if (!inPart.length) continue;
        rows.push(
            new d.TableRow({
                children: [
                    new d.TableCell({
                        columnSpan: 3,
                        children: [
                            new d.Paragraph({
                                alignment: d.AlignmentType.CENTER,
                                spacing: { line: 480 },
                                children: [run(part === "I" ? "PART-I (Documents other than exhibits)" : "PART-II (Exhibits)", true)],
                            }),
                        ],
                    }),
                ],
            }),
        );
        for (const entry of inPart) {
            const pages = entry.firstPage === entry.lastPage ? `${entry.firstPage}` : `${entry.firstPage}-${entry.lastPage}`;
            rows.push(
                new d.TableRow({
                    children: [
                        cell(`${entry.serial}.`, 12, false, d.AlignmentType.CENTER),
                        cell(entry.description, 66),
                        cell(pages, 22, false, d.AlignmentType.CENTER),
                    ],
                }),
            );
        }
    }
    const doc = new d.Document({
        creator: "Spectre",
        title: `Paper book index: ${causeTitle}`,
        sections: [
            {
                properties: {
                    page: {
                        size: { width: twips(8), height: twips(13) },
                        margin: { left: twips(2), right: twips(1.5), top: twips(1), bottom: twips(2) },
                    },
                },
                children: [
                    new d.Paragraph({ alignment: d.AlignmentType.CENTER, spacing: { line: 480 }, children: [run(causeTitle, true)] }),
                    new d.Paragraph({ alignment: d.AlignmentType.CENTER, spacing: { line: 480, after: 240 }, children: [run("INDEX", true)] }),
                    new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows }),
                ],
            },
        ],
    });
    return Buffer.from(await d.Packer.toBuffer(doc));
}

/** Add a bookmark (outline item) for each entry, opening at its first page. */
async function addBookmarks(
    book: PdfLibDocument,
    marks: { title: string; page: PDFRef }[],
): Promise<void> {
    const { PDFHexString, PDFName, PDFNumber } = await import("pdf-lib");
    if (!marks.length) return;
    const context = book.context;
    const outlinesRef = context.nextRef();
    const refs = marks.map(() => context.nextRef());
    marks.forEach((mark, i) => {
        const item = context.obj({
            Title: PDFHexString.fromText(mark.title),
            Parent: outlinesRef,
            Dest: context.obj([mark.page, PDFName.of("Fit")]),
        });
        if (i > 0) item.set(PDFName.of("Prev"), refs[i - 1]);
        if (i < refs.length - 1) item.set(PDFName.of("Next"), refs[i + 1]);
        context.assign(refs[i], item);
    });
    context.assign(
        outlinesRef,
        context.obj({
            Type: "Outlines",
            First: refs[0],
            Last: refs[refs.length - 1],
            Count: PDFNumber.of(refs.length),
        }),
    );
    book.catalog.set(PDFName.of("Outlines"), outlinesRef);
    book.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

/** Assemble a paper book. Items keep their order within each Part. */
export async function buildPaperBook(params: {
    causeTitle: string;
    items: PaperBookItem[];
    renderIndex: RenderIndex;
}): Promise<PaperBook> {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    if (!params.items.length) throw new Error("A paper book needs at least one document.");
    const ordered = [
        ...params.items.filter((i) => i.part === "I"),
        ...params.items.filter((i) => i.part === "II"),
    ];
    const sources = await Promise.all(
        ordered.map((item) => PDFDocument.load(item.pdf, { ignoreEncryption: true })),
    );

    const entries: PaperBookEntry[] = [];
    let next = 1;
    ordered.forEach((item, i) => {
        const count = sources[i].getPageCount();
        entries.push({ serial: i + 1, description: item.description, part: item.part, firstPage: next, lastPage: next + count - 1 });
        next += count;
    });
    const pageCount = next - 1;

    const book = await PDFDocument.create();
    book.setTitle(`Paper book: ${params.causeTitle}`);
    book.setCreator("Spectre");
    const index = await PDFDocument.load(await params.renderIndex(await paperBookIndexDocx(params.causeTitle, entries)));
    const indexPages = await book.copyPages(index, index.getPageIndices());
    for (const page of indexPages) book.addPage(page);

    const numberFont = await book.embedFont(StandardFonts.TimesRoman);
    const { width: W, height: H } = PAPER_BOOK_PAGE;
    const m = PAPER_BOOK_MARGINS;
    const boxW = W - m.left - m.right;
    const boxH = H - m.top - m.bottom;
    const marks: { title: string; page: PDFRef }[] = [{ title: "Index", page: book.getPage(0).ref }];
    let pageNumber = 1;
    for (const [i, source] of sources.entries()) {
        const embedded = await book.embedPages(source.getPages());
        for (const [j, page] of embedded.entries()) {
            const sheet = book.addPage([W, H]);
            const scale = Math.min(boxW / page.width, boxH / page.height, 1);
            const w = page.width * scale;
            const h = page.height * scale;
            // Centred in the Rule's text area.
            sheet.drawPage(page, { x: m.left + (boxW - w) / 2, y: m.bottom + (boxH - h) / 2, width: w, height: h });
            const label = String(pageNumber);
            const size = 12;
            sheet.drawText(label, {
                x: m.left + boxW / 2 - numberFont.widthOfTextAtSize(label, size) / 2,
                y: m.bottom / 2,
                size,
                font: numberFont,
                color: rgb(0, 0, 0),
            });
            if (j === 0) {
                const entry = entries[i];
                marks.push({ title: `${entry.serial}. ${entry.description} (p. ${entry.firstPage})`, page: sheet.ref });
            }
            pageNumber += 1;
        }
    }
    await addBookmarks(book, marks);
    return {
        pdf: await book.save(),
        entries,
        pageCount,
        indexPages: indexPages.length,
        needsHardboardCover: pageCount > HARDBOARD_COVER_PAGES,
    };
}
