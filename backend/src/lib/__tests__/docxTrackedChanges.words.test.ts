// Tracked changes are recorded word by word, as Word's own compare does:
// never a fragment of a word, and in Bangla never a lone vowel sign or half
// a conjunct.
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { applyTrackedEdits, extractDocxBodyText } from "../docxTrackedChanges";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function docx(text: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

async function edit(text: string, find: string, replace: string) {
    const result = await applyTrackedEdits(await docx(text), [{ find, replace }]);
    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(1);
    return { change: result.changes[0], bytes: result.bytes };
}

describe("word-level tracked changes", () => {
    it("marks a whole English word, not an added letter", async () => {
        const { change } = await edit("The Supplier shall deliver.", "Supplier", "Suppliers");
        expect(change.deletedText).toBe("Supplier");
        expect(change.insertedText).toBe("Suppliers");
    });

    it("keeps a minimal range when the edit already falls on word boundaries", async () => {
        const { change, bytes } = await edit("The Buyer shall pay the price.", "shall pay", "shall not pay");
        expect(change.deletedText).toBe("");
        expect(change.insertedText).toBe("not ");
        await expect(extractDocxBodyText(bytes)).resolves.toBe("The Buyer shall not pay the price.");
    });

    it("never records a lone Bangla vowel sign as the change", async () => {
        // কাজ → কাজে differs only by the vowel sign ে.
        const { change, bytes } = await edit("এই কাজ শেষ হবে।", "কাজ", "কাজে");
        expect(change.deletedText).toBe("কাজ");
        expect(change.insertedText).toBe("কাজে");
        await expect(extractDocxBodyText(bytes)).resolves.toBe("এই কাজে শেষ হবে।");
    });

    it("never splits a conjunct", async () => {
        // মন্ত্রণালয় → মন্ত্রণালয়ের: the changed word is marked whole.
        const { change } = await edit("সংস্থাপন মন্ত্রণালয় জানাবে।", "মন্ত্রণালয়", "মন্ত্রণালয়ের");
        expect(change.deletedText).toBe("মন্ত্রণালয়");
        expect(change.insertedText).toBe("মন্ত্রণালয়ের");
    });

    it("marks a changed amount word, keeping the unchanged words outside", async () => {
        const { change } = await edit("Rent is Tk 1,20,000 per month.", "Tk 1,20,000 per month", "Tk 1,50,000 per month");
        expect(change.deletedText).toBe("1,20,000");
        expect(change.insertedText).toBe("1,50,000");
    });
});
