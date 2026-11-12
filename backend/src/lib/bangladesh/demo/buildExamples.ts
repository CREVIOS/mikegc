// Build a use case's documents: the foreign party's draft as a Word file, and
// the Bangladeshi lawyer's markup applied to it as real Word tracked changes
// by the same engine the assistant edits documents with.

import {
    applyTrackedEdits,
    extractDocxBodyText,
    type AppliedChange,
} from "../../docxTrackedChanges";
import { banglaDocumentFont } from "../../bangla/fonts";
import type { UseCase } from "./useCases";

export const REDLINE_AUTHOR = "Spectre";

/** The draft as the foreign party sent it. */
export async function useCaseDraftDocx(useCase: UseCase): Promise<Buffer> {
    const { AlignmentType, Document, Packer, Paragraph, TextRun } = await import("docx");
    const font = { ascii: "Times New Roman", hAnsi: "Times New Roman", cs: banglaDocumentFont() };
    const run = (text: string, bold = false) => new TextRun({ text, bold, font, size: 22 });
    const children = [
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 },
            children: [run(useCase.document.title.toUpperCase(), true)],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 360 },
            children: [run(useCase.document.parties)],
        }),
        ...useCase.document.clauses.flatMap((clause) => [
            new Paragraph({ spacing: { before: 240, after: 60 }, children: [run(clause.heading, true)] }),
            new Paragraph({ spacing: { after: 120 }, alignment: AlignmentType.JUSTIFIED, children: [run(clause.text)] }),
        ]),
    ];
    const doc = new Document({
        creator: "Spectre",
        title: useCase.document.title,
        sections: [{ children }],
    });
    return Buffer.from(await Packer.toBuffer(doc));
}

export type UseCaseRedline = {
    draft: Buffer;
    redline: Buffer;
    /** One applied change per edit, in order, with the edit's provision and reason. */
    changes: (AppliedChange & { provision: string; reason: string })[];
    /** The redline with every change accepted. */
    acceptedText: string;
};

/** Apply the lawyer's markup to the draft as tracked changes. */
export async function redlineUseCase(useCase: UseCase): Promise<UseCaseRedline> {
    const draft = await useCaseDraftDocx(useCase);
    const result = await applyTrackedEdits(
        draft,
        useCase.edits.map((edit) => ({
            find: edit.find,
            replace: edit.replace,
            context_before: "",
            context_after: "",
            reason: edit.reason,
        })),
        { author: REDLINE_AUTHOR },
    );
    if (result.errors.length) {
        throw new Error(
            `${useCase.id}: ${result.errors.length} edit(s) did not apply: ${result.errors
                .map((e) => `#${e.index} ${e.reason}`)
                .join("; ")}`,
        );
    }
    return {
        draft,
        redline: result.bytes,
        changes: result.changes.map((change, index) => ({
            ...change,
            provision: useCase.edits[index].provision,
            reason: useCase.edits[index].reason,
        })),
        acceptedText: await extractDocxBodyText(result.bytes),
    };
}
