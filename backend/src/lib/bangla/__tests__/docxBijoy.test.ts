import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocxBodyText } from "../../docxTrackedChanges";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function makeDocx(bodyXml: string, stylesXml?: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    if (stylesXml) {
        zip.file(
            "word/styles.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>${stylesXml}</w:styles>`,
        );
    }
    return zip.generateAsync({ type: "nodebuffer" });
}

const run = (text: string, font?: string) =>
    `<w:r>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

describe("reading Bijoy Bangla from DOCX", () => {
    it("converts runs set in an MJ font and leaves the rest exactly as written", async () => {
        const bytes = await makeDocx(
            `<w:p>${run("Agreement: ")}${run("Pzw³cÎ", "SutonnyMJ")}${run(" (Dhaka)")}</w:p>`,
        );
        await expect(extractDocxBodyText(bytes, { readableBangla: true })).resolves.toBe(
            `Agreement: ${"চুক্তিপত্র".normalize("NFC")} (Dhaka)`,
        );
        // The edit matcher's view is untouched.
        await expect(extractDocxBodyText(bytes)).resolves.toBe(
            "Agreement: Pzw³cÎ (Dhaka)",
        );
    });

    it("joins a word split across Bijoy runs before converting it", async () => {
        // ‡ (the vowel sign ে) and its consonant land in different runs.
        const bytes = await makeDocx(
            `<w:p>${run("evsjv‡", "SutonnyMJ")}${run("`k", "SutonnyMJ")}</w:p>`,
        );
        await expect(extractDocxBodyText(bytes, { readableBangla: true })).resolves.toBe(
            "বাংলাদেশ".normalize("NFC"),
        );
    });

    it("follows the paragraph style, the default style and the document defaults", async () => {
        const styles =
            `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:rPrDefault></w:docDefaults>` +
            `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
            `<w:style w:type="paragraph" w:styleId="Bangla"><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="SutonnyOMJ" w:hAnsi="SutonnyOMJ"/></w:rPr></w:style>`;
        const bytes = await makeDocx(
            `<w:p><w:pPr><w:pStyle w:val="Bangla"/></w:pPr>${run("aviv 23")}</w:p><w:p>${run("Section 23")}</w:p>`,
            styles,
        );
        await expect(extractDocxBodyText(bytes, { readableBangla: true })).resolves.toBe(
            `${"ধারা ২৩".normalize("NFC")}\nSection 23`,
        );
    });

    it("leaves a Unicode Bangla document byte for byte as written", async () => {
        const decomposed = "বাংলায়"; // য + nukta, not NFC's choice of form
        const bytes = await makeDocx(`<w:p>${run(decomposed, "Nikosh")}</w:p>`);
        await expect(extractDocxBodyText(bytes, { readableBangla: true })).resolves.toBe(decomposed);
    });
});
