import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    bdLawsUrl,
    BdLawsError,
    clearBdLawsCache,
    decodeBdLawsBody,
    readBdLaw,
    searchBdLaws,
} from "../bdlaws";

/** The site's real encoding: UTF-16 big-endian bytes, labelled "UTF-16". */
function utf16be(text: string): Uint8Array {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[2 * i] = code >> 8;
        out[2 * i + 1] = code & 0xff;
    }
    return out;
}

function siteResponse(html: string, status = 200): Response {
    return new Response(utf16be(html), {
        status,
        headers: { "content-type": "text/html;charset=UTF-16" },
    });
}

// Markup as bdlaws.minlaw.gov.bd serves it (trimmed).
const SEARCH_HTML = `<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-16BE"><title>Laws of Bangladesh</title></head><body>
<div id="searchtext"><div class="row well well-sm searchable">
<div class="result "><h3 class="r"><a href="https://bdlaws.minlaw.gov.bd/act-26.html?hl=1">The Contract Act, 1872</a></h3>
<div class="s"><div class="resm">/act-26.html</div><p>Whereas it is expedient to define and amend certain parts of the law relating to contracts; It is enacted as follows:-...</p></div></div>
<div class="result repealed"><h3 class="r"><a href="https://bdlaws.minlaw.gov.bd/act-133/chapter-334.html?hl=1">The Cantonments Act, 1924</a></h3>
<div class="s"><div class="resm">/act-133/chapter-334.html</div><p>CONTRACTS...</p></div></div>
<div class="result "><h3 class="r"><a href="https://evil.example/act-1.html">Not the site</a></h3><div class="s"><p>x</p></div></div>
</div><div class="row well well-sm"><div class="col-sm-4"><div class="text-info text-center pagination">1 to 20 of 904</div></div></div></div>
</body></html>`;

const SECTION_HTML = `<!DOCTYPE html><html lang="en"><head><title>The Contract Act, 1872  | 23. What considerations and objects are lawful, and what not</title></head><body>
<div class="col-md-11 boxed-layout masterContent" id="page-content">
<section class="bg-act-section padding-bottom-20"><div class="text-center"><h3><span class="footnote" title="Throughout this Act..."><span class="word-formet"><sup class="en">1</sup></span></span>The Contract Act, 1872</h3>
<h4 style="color: #fff;"> ( ACT NO. IX OF 1872 ) </h4></div></section>
<section class="bt-act-section-search"><p class="pull-right print-center publish-date">[ 25th April, 1872 ]</p></section>
<section class="padding-bottom-20 bg-striped "><div class="row lineremoves ">
<div class="act-chapter-group"><p class="act-chapter-name">OF CONTRACTS, VOIDABLE CONTRACTS AND VOID AGREEMENTS</p></div>
<div class="col-sm-3 txt-head">What considerations and objects are lawful, and what not</div>
<div class="col-sm-9 txt-details" id="sec-dec">23. The consideration or object of an agreement is lawful, unless it is forbidden by law; or is of such a nature that, if permitted, it would defeat the provisions of any law;</div>
</div><div class="footnoteListAll"><ul class="list-unstyled"><li class="footnoteList"><h6 class="word-formet"><sup class="en">1</sup></h6> Throughout this Act, the words "Bangladesh" and "Taka" were substituted by section 3 of Act No. VIII of 1973.</li></ul></div></section>
</div></body></html>`;

const BANGLA_ACT_HTML = `<!DOCTYPE html><html><head><title>ব্যক্তিগত উপাত্ত সুরক্ষা আইন, ২০২৬</title></head><body>
<section class="bg-act-section"><h3>ব্যক্তিগত উপাত্ত সুরক্ষা আইন, ২০২৬</h3><h4> ( ২০২৬ সনের ৬৩ নং আইন ) </h4></section>
<section><p class="publish-date">[ ১০ এপ্রিল, ২০২৬ ]</p></section>
<section class=" search-here"><p class="act-section-name "><a href="https://bdlaws.minlaw.gov.bd/act-1692/section-50001.html">১। সংক্ষিপ্ত শিরোনাম ও প্রবর্তন</a></p>
<p class="act-section-name "><a href="https://bdlaws.minlaw.gov.bd/act-1692/section-50002.html">২। সংজ্ঞা</a></p></section>
</body></html>`;

describe("Laws of Bangladesh client", () => {
    beforeEach(() => clearBdLawsCache());

    it("decodes the site's UTF-16BE pages, Bangla included", () => {
        const text = "<p>২০২৬ সনের ৬৩ নং আইন</p>";
        expect(decodeBdLawsBody(utf16be(text), "text/html;charset=UTF-16")).toBe(text);
        // A UTF-8 page is read as UTF-8.
        expect(decodeBdLawsBody(new TextEncoder().encode(text), "text/html; charset=UTF-8")).toBe(text);
    });

    it("searches and returns only results on the site, marking repealed laws", async () => {
        const fetch = vi.fn(async () => siteResponse(SEARCH_HTML));
        const found = await searchBdLaws("contract", { fetch });
        expect(fetch).toHaveBeenCalledWith(
            "https://bdlaws.minlaw.gov.bd/search.html?q=contract",
            expect.objectContaining({ redirect: "manual" }),
        );
        expect(found.total).toBe(904);
        expect(found.results).toEqual([
            {
                title: "The Contract Act, 1872",
                url: "https://bdlaws.minlaw.gov.bd/act-26.html",
                snippet: expect.stringContaining("law relating to contracts"),
                repealed: false,
            },
            {
                title: "The Cantonments Act, 1924",
                url: "https://bdlaws.minlaw.gov.bd/act-133/chapter-334.html",
                snippet: "CONTRACTS...",
                repealed: true,
            },
        ]);
    });

    it("reads a section with its Act, number, date and footnotes", async () => {
        const fetch = vi.fn(async () => siteResponse(SECTION_HTML));
        const page = await readBdLaw("https://bdlaws.minlaw.gov.bd/act-26/section-182.html", { fetch });
        expect(page.title).toBe("The Contract Act, 1872");
        expect(page.number).toBe("ACT NO. IX OF 1872");
        expect(page.date).toBe("25th April, 1872");
        expect(page.text).toContain("23. The consideration or object of an agreement is lawful");
        expect(page.text).toContain("OF CONTRACTS, VOIDABLE CONTRACTS AND VOID AGREEMENTS");
        expect(page.footnotes[0]).toContain("Act No. VIII of 1973");
        expect(page.repealed).toBe(false);
    });

    it("reads a Bangla Act's table of contents", async () => {
        const fetch = vi.fn(async () => siteResponse(BANGLA_ACT_HTML));
        const page = await readBdLaw("/act-1692.html", { fetch, lang: "bn" });
        expect(fetch.mock.calls[0][0]).toBe("https://bdlaws.minlaw.gov.bd/act-1692.html?lang=bn");
        expect(page.title).toBe("ব্যক্তিগত উপাত্ত সুরক্ষা আইন, ২০২৬");
        expect(page.number).toBe("২০২৬ সনের ৬৩ নং আইন");
        expect(page.sections).toEqual([
            { label: "১। সংক্ষিপ্ত শিরোনাম ও প্রবর্তন", url: "https://bdlaws.minlaw.gov.bd/act-1692/section-50001.html" },
            { label: "২। সংজ্ঞা", url: "https://bdlaws.minlaw.gov.bd/act-1692/section-50002.html" },
        ]);
    });

    it("caches a page for an hour", async () => {
        let now = 0;
        const fetch = vi.fn(async () => siteResponse(SECTION_HTML));
        await readBdLaw("/act-26/section-182.html", { fetch, now: () => now });
        now += 30 * 60 * 1000;
        await readBdLaw("/act-26/section-182.html", { fetch, now: () => now });
        expect(fetch).toHaveBeenCalledTimes(1);
        now += 31 * 60 * 1000;
        await readBdLaw("/act-26/section-182.html", { fetch, now: () => now });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("reads only law pages on the one host", () => {
        expect(bdLawsUrl("https://bdlaws.minlaw.gov.bd/act-26.html")).toBe("https://bdlaws.minlaw.gov.bd/act-26.html");
        expect(bdLawsUrl("http://bdlaws.minlaw.gov.bd/act-details-26.html#s1")).toBe(
            "https://bdlaws.minlaw.gov.bd/act-details-26.html",
        );
        for (const url of [
            "https://evil.example/act-26.html",
            "https://bdlaws.minlaw.gov.bd.evil.example/act-26.html",
            "https://bdlaws.minlaw.gov.bd/contact-us.html",
            "https://bdlaws.minlaw.gov.bd/act-26.html/../../etc/passwd",
            "javascript:alert(1)",
        ]) {
            expect(bdLawsUrl(url)).toBeNull();
        }
    });

    it("reports a missing page, an error and a refused URL as typed errors", async () => {
        await expect(
            readBdLaw("/act-99999.html", { fetch: async () => siteResponse("", 404) }),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(
            readBdLaw("/act-26.html", { fetch: async () => siteResponse("", 503) }),
        ).rejects.toMatchObject({ code: "unavailable" });
        await expect(
            readBdLaw("/act-26.html", { fetch: async () => { throw new TypeError("fetch failed"); } }),
        ).rejects.toBeInstanceOf(BdLawsError);
        await expect(readBdLaw("https://evil.example/act-26.html")).rejects.toMatchObject({
            code: "invalid_url",
        });
    });
});
