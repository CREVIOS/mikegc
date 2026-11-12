import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("../../../../lib/storage", () => ({
  downloadFile: vi.fn(),
  generatedDocKey: (userId: string, docId: string, filename: string) =>
    `generated/${userId}/${docId}/${filename}`,
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

vi.mock("../../../../lib/downloadTokens", () => ({
  buildDownloadUrl: () => "/download/test-token",
}));

import { generateDocx } from "../tools/documentOps";

function fakeDb() {
  return {
    rpc: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
    from(table: string) {
      const result = { data: null, error: null };
      const query: Record<string, unknown> = {};
      query.insert = vi.fn(() => query);
      query.select = vi.fn(() => query);
      query.update = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.single = vi.fn(async () => ({
        data: { id: table === "documents" ? "doc-1" : "version-1" },
        error: null,
      }));
      query.then = (
        resolve: (value: typeof result) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return query;
    },
  };
}

async function generatedXml(options: {
  sections: unknown[];
  numberSections?: boolean;
}): Promise<{ documentXml: string; numberingXml: string; stylesXml: string }> {
  let bytes: ArrayBuffer | undefined;
  uploadFileMock.mockImplementationOnce(
    async (_key: string, uploaded: ArrayBuffer) => {
      bytes = uploaded;
    },
  );

  const result = await generateDocx(
    "Generated document",
    options.sections,
    "test-user",
    fakeDb() as never,
    options.numberSections === undefined
      ? undefined
      : { numberSections: options.numberSections },
  );

  expect(result).not.toHaveProperty("error");
  expect(bytes).toBeDefined();
  const archive = await JSZip.loadAsync(bytes!);
  const documentXml = await archive.file("word/document.xml")!.async("string");
  const numberingXml = await archive.file("word/numbering.xml")!.async("string");
  const stylesXml = (await archive.file("word/styles.xml")?.async("string")) ?? "";
  return { documentXml, numberingXml, stylesXml };
}

function paragraphContaining(xml: string, text: string): string {
  return (
    xml
      .match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((paragraph) => paragraph.includes(text)) ?? ""
  );
}

beforeEach(() => {
  uploadFileMock.mockReset();
});

describe("generateDocx Bangla", () => {
  it("keeps Bangla text intact and gives it a Unicode Bangla font and language", async () => {
    const bangla = "এই চুক্তি বাংলাদেশের আইন অনুযায়ী পরিচালিত হবে।";
    const { documentXml, stylesXml } = await generatedXml({
      sections: [{ heading: "পরিচালনাকারী আইন", content: bangla }],
    });
    expect(documentXml).toContain(bangla);
    // Every run names the complex-script font Word draws Bangla with.
    expect(documentXml).toContain('w:cs="Nirmala UI"');
    expect(documentXml).not.toMatch(/w:cs="[^"]*MJ"/);
    // The document defaults tag Bangla runs bn-BD and size them like Latin text.
    expect(stylesXml).toContain('w:bidi="bn-BD"');
    expect(stylesXml).toMatch(/<w:szCs w:val="22"\/>/);
  });
});

describe("generateDocx numbering", () => {
  it("leaves demand-letter headings and prose unnumbered by default", async () => {
    const { documentXml } = await generatedXml({
      sections: [
        {
          heading: "Demand for Payment",
          content:
            "We represent the claimant.\nPayment is required within ten days.",
        },
      ],
    });

    expect(paragraphContaining(documentXml, "DEMAND FOR PAYMENT")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(documentXml, "We represent the claimant."),
    ).not.toContain("<w:numPr>");
    expect(
      paragraphContaining(documentXml, "Payment is required within ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("numbers only headings when legal section numbering is requested", async () => {
    const { documentXml } = await generatedXml({
      numberSections: true,
      sections: [
        {
          heading: "Payment Terms",
          content: "Payment is due monthly.\nInvoices are payable in ten days.",
        },
      ],
    });

    expect(paragraphContaining(documentXml, "PAYMENT TERMS")).toContain(
      "<w:numPr>",
    );
    expect(paragraphContaining(documentXml, "Payment is due monthly.")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(documentXml, "Invoices are payable in ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("preserves manually typed numbering when automatic numbering is off", async () => {
    const { documentXml } = await generatedXml({
      sections: [{ content: "1. This reference is intentional." }],
    });
    const paragraph = paragraphContaining(
      documentXml,
      "1. This reference is intentional.",
    );

    expect(paragraph).toContain("1. This reference is intentional.");
    expect(paragraph).not.toContain("<w:numPr>");
  });

  it("renders explicit bullets as bullets rather than legal clauses", async () => {
    const { documentXml, numberingXml } = await generatedXml({
      numberSections: true,
      sections: [
        {
          heading: "Requirements",
          content: "- First item\n- Second item",
        },
      ],
    });

    const first = paragraphContaining(documentXml, "First item");
    const second = paragraphContaining(documentXml, "Second item");
    expect(first).toContain("<w:numPr>");
    expect(second).toContain("<w:numPr>");
    expect(first).not.toContain("- First item");
    expect(second).not.toContain("- Second item");
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"/>');
  });
});
