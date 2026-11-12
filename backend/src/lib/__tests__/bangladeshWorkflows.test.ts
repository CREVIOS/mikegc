// The Bangladesh workflow pack in workflows/bangladesh/ is laid out as the
// system workflows repository (MIKE_WORKFLOWS_REPOSITORY) expects. This test
// runs it through the real catalog parser, next to the default workflows the
// sync requires, so the pack is known to load once copied into that
// repository.
import { mkdtemp, readdir, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { prepareWorkflowCatalog, validateWorkflowCatalogDocument } from "../workflowCatalogSource";

const PACK_ROOT = path.resolve(__dirname, "../../../../workflows/bangladesh");
const COMMIT = "b".repeat(40);

const DEFAULTS: Array<[string, "assistant" | "tabular"]> = [
    ["contract-intake", "assistant"],
    ["contract-markup", "assistant"],
    ["obligation-tracking", "assistant"],
    ["proofread", "assistant"],
    ["compare-documents", "assistant"],
    ["extract-key-terms", "assistant"],
    ["draft-from-template", "assistant"],
    ["commercial-agreement-tabular-review", "tabular"],
];

function defaultSkill(key: string, type: "assistant" | "tabular") {
    return `---
name: "${key}"
description: "Default"
license: "MIT"
metadata:
  version: "1.0.0"
  author: "Test"
  language: "English"
  mike-display-name: "${key}"
  mike-type: "${type}"
  practice: "General Transactions"
  jurisdictions: "General"
---
Default workflow.
`;
}

async function filesUnder(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const name of await readdir(dir)) {
        const full = path.join(dir, name);
        if ((await stat(full)).isDirectory()) out.push(...(await filesUnder(full)));
        else out.push(full);
    }
    return out;
}

async function archive(): Promise<Buffer> {
    const zip = new JSZip();
    const root = "workflows-test/";
    for (const [key, type] of DEFAULTS) {
        const collection = type === "assistant" ? "assistant-workflows" : "tabular-review-workflows";
        zip.file(`${root}${collection}/${key}/SKILL.md`, defaultSkill(key, type));
        if (type === "tabular") {
            zip.file(
                `${root}${collection}/${key}/table-columns.yaml`,
                'columns:\n  - index: 0\n    name: "Issue"\n    prompt: "Identify the issue"\n',
            );
        }
    }
    for (const file of await filesUnder(PACK_ROOT)) {
        zip.file(`${root}${path.relative(PACK_ROOT, file).split(path.sep).join("/")}`, await readFile(file));
    }
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function githubFetch(zipBytes: Buffer) {
    return vi.fn(async (url: string | URL | Request) => {
        const value = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        if (new URL(value).hostname === "api.github.com") {
            return new Response(JSON.stringify({ sha: COMMIT }), { status: 200 });
        }
        return new Response(new Uint8Array(zipBytes), {
            status: 200,
            headers: { "content-length": String(zipBytes.byteLength) },
        });
    }) as typeof fetch;
}

describe("Bangladesh workflow pack", () => {
    it("loads through the catalog parser with every workflow", async () => {
        const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bd-workflows-"));
        try {
            const prepared = await prepareWorkflowCatalog({
                temporaryRoot,
                fetchImpl: githubFetch(await archive()),
            });
            const document = validateWorkflowCatalogDocument(
                JSON.parse(await readFile(prepared.catalogPath, "utf8")) as unknown,
            );
            const bangladesh = document.workflows.filter((w) => w.workflow_key.startsWith("bd-"));
            expect(bangladesh.map((w) => w.workflow_key).sort()).toEqual([
                "bd-cheque-dishonour",
                "bd-contract-compliance-review",
                "bd-contract-review",
                "bd-data-protection-review",
                "bd-employment-contract-review",
                "bd-legal-notice",
                "bd-legal-translation",
                "bd-plaint-draft",
                "bd-statute-check",
            ]);
            const asJson = JSON.stringify(bangladesh);
            expect(asJson).toContain("Bangladesh");
            const review = bangladesh.find((w) => w.workflow_key === "bd-contract-compliance-review");
            expect(JSON.stringify(review)).toContain("Governing Law");
        } finally {
            await rm(temporaryRoot, { recursive: true, force: true });
        }
    });
});
