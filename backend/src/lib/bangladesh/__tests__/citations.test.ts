import { describe, expect, it } from "vitest";
import { findBangladeshCaseCitations, unverifiedCaseCitations } from "../citations";

describe("Bangladeshi law-report citations", () => {
    it("finds the reporter forms Bangladeshi courts and firms use", () => {
        const text =
            "See Hasmat Ullah v Azmiri Bibi 44 DLR (HCD) 1992 and A T Mridha v State (1973) 25 DLR (HCD) 335, " +
            "affirmed in 56 DLR(AD)1; also 17 BLD (AD) 1, 15 BLC (AD) 45, (2015) 4 LNJ (AD) 123, 5 MLR (AD) 1, " +
            "22 DLR (SC) 10 and 15 SCOB [2021] AD 1.";
        expect(findBangladeshCaseCitations(text).map((c) => c.key)).toEqual([
            "44 DLR (HCD) 1992",
            "25 DLR (HCD) 335",
            "56 DLR (AD) 1",
            "17 BLD (AD) 1",
            "15 BLC (AD) 45",
            "4 LNJ (AD) 123",
            "5 MLR (AD) 1",
            "22 DLR (SC) 10",
            "15 SCOB [2021] AD 1",
        ]);
    });

    it("ignores statutes, sections and US or UK reporters", () => {
        expect(
            findBangladeshCaseCitations(
                "Act No. IX of 1872, section 23; 467 U.S. 837; [2004] UKHL 22; Order XXXIX rules 1 and 2; Tk 1,25,000",
            ),
        ).toEqual([]);
    });

    it("flags only citations no source contains, however spacing differs", () => {
        const answer = "The Appellate Division held so in 56 DLR (AD) 1 and in 70 DLR (AD) 99.";
        const judgment = "…as reported in 56 DLR(AD) 1, the Court…";
        expect(unverifiedCaseCitations(answer, [judgment]).map((c) => c.key)).toEqual(["70 DLR (AD) 99"]);
        expect(unverifiedCaseCitations(answer, [judgment, "see 70 dlr (ad) 99"])).toEqual([]);
        expect(unverifiedCaseCitations("No authorities here.", [])).toEqual([]);
    });
});
