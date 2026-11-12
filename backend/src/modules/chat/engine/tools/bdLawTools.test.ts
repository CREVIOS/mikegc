import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearBdLawsCache } from "../../../../lib/bdlaws";
import {
    BD_LAW_TOOL_NAMES,
    BD_LAW_TOOLS,
    bdLawToolsEnabled,
    createBdLawTurnState,
    runBdLawToolCall,
} from "./bdLawTools";

const SEARCH_HTML = `<html><body><div class="result "><h3 class="r"><a href="https://bdlaws.minlaw.gov.bd/act-850.html?hl=1">The Arbitration Act, 2001</a></h3><div class="s"><p>An Act to make provision for arbitration...</p></div></div><div class="pagination">1 to 1 of 1</div></body></html>`;
const ACT_HTML = `<html><head><title>The Arbitration Act, 2001</title></head><body><section class="bg-act-section"><h3>The Arbitration Act, 2001</h3><h4>( ACT NO. I OF 2001 )</h4></section><p class="act-section-name"><a href="https://bdlaws.minlaw.gov.bd/act-850/section-30000.html">45. Enforcement of foreign arbitral award</a></p></body></html>`;

function html(body: string) {
    return new Response(body, { headers: { "content-type": "text/html; charset=UTF-8" } });
}

function call(name: string, input: Record<string, unknown>, id = "call-1") {
    return { id, name, input } as never;
}

describe("Laws of Bangladesh tools", () => {
    beforeEach(() => clearBdLawsCache());

    it("is on for a Bangladesh deployment and can be switched either way", () => {
        expect(bdLawToolsEnabled({})).toBe(true);
        expect(bdLawToolsEnabled({ SPECTRE_BDLAWS_ENABLED: "false" })).toBe(false);
        expect(bdLawToolsEnabled({ SPECTRE_DEFAULT_JURISDICTION: "none" })).toBe(false);
        expect(
            bdLawToolsEnabled({ SPECTRE_DEFAULT_JURISDICTION: "none", SPECTRE_BDLAWS_ENABLED: "true" }),
        ).toBe(true);
        expect(BD_LAW_TOOLS.map((tool) => tool.function.name)).toEqual(["bd_law_search", "bd_law_read"]);
    });

    it("searches, fences the results and reports a web search event", async () => {
        const write = vi.fn();
        const result = await runBdLawToolCall(call(BD_LAW_TOOL_NAMES.search, { query: "arbitration" }), {
            state: createBdLawTurnState(),
            nonce: "n1",
            write,
            fetch: async () => html(SEARCH_HTML),
        });
        expect(write.mock.calls[0][0]).toContain('"type":"web_search_start"');
        expect(result.event).toEqual({
            type: "web_search",
            search_id: "call-1",
            query: "Laws of Bangladesh: arbitration",
            results: [{ url: "https://bdlaws.minlaw.gov.bd/act-850.html", title: "The Arbitration Act, 2001" }],
        });
        expect(result.content).toContain('<untrusted-content nonce="n1">');
        expect(result.content).toContain("https://bdlaws.minlaw.gov.bd/act-850.html");
    });

    it("reads an Act and lists its sections", async () => {
        const result = await runBdLawToolCall(
            call(BD_LAW_TOOL_NAMES.read, { url: "https://bdlaws.minlaw.gov.bd/act-850.html" }),
            { state: createBdLawTurnState(), write: vi.fn(), fetch: async () => html(ACT_HTML) },
        );
        expect(result.content).toContain("Title: The Arbitration Act, 2001");
        expect(result.content).toContain("Number: ACT NO. I OF 2001");
        expect(result.content).toContain("45. Enforcement of foreign arbitral award: https://bdlaws.minlaw.gov.bd/act-850/section-30000.html");
        expect(result.event).toMatchObject({ type: "web_read", title: "The Arbitration Act, 2001" });
    });

    it("refuses other hosts without fetching", async () => {
        const fetch = vi.fn();
        const result = await runBdLawToolCall(
            call(BD_LAW_TOOL_NAMES.read, { url: "https://attacker.example/act-1.html?leak=secret" }),
            { state: createBdLawTurnState(), write: vi.fn(), fetch },
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(result.event).toMatchObject({ type: "web_read", error_code: "unreadable" });
    });

    it("stops at the per-answer budget", async () => {
        const state = { searches: 10, reads: 0 };
        const fetch = vi.fn();
        const result = await runBdLawToolCall(call(BD_LAW_TOOL_NAMES.search, { query: "x" }), {
            state,
            write: vi.fn(),
            fetch,
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(JSON.parse(result.content)).toMatchObject({ status: "unavailable" });
    });
});
