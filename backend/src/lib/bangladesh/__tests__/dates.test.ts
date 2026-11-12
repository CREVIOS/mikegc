import { describe, expect, it } from "vitest";
import { formatBangabda, formatGregorianBangla, toBangabda } from "../dates";
import { formatMessageTime } from "../../userTime";

const nfc = (s: string) => s.normalize("NFC");

describe("Bangla calendar (Bangladesh's revised calendar)", () => {
    it("matches dates printed in gazettes and newspapers", () => {
        // A gazette's dual date: "১৭ মাঘ, ১৪২৯/৩১ জানুয়ারি, ২০২৩".
        expect(toBangabda(2023, 1, 31)).toEqual({ year: 1429, month: 10, day: 17 });
        // A newspaper dateline: 8 September 2026 = 24 Bhadro 1433.
        expect(toBangabda(2026, 9, 8)).toEqual({ year: 1433, month: 5, day: 24 });
        expect(formatBangabda(2026, 11, 12)).toBe(nfc("২৭ কার্তিক ১৪৩৩"));
    });

    it("starts the year on 14 April and gives Falgun 30 days in a leap year", () => {
        expect(toBangabda(2026, 4, 14)).toEqual({ year: 1433, month: 1, day: 1 });
        expect(toBangabda(2026, 4, 13)).toEqual({ year: 1432, month: 12, day: 30 });
        // Falgun 1432 starts 14 February and, in non-leap 2026, has 29 days.
        expect(toBangabda(2026, 2, 14)).toEqual({ year: 1432, month: 11, day: 1 });
        expect(toBangabda(2026, 3, 14)).toEqual({ year: 1432, month: 11, day: 29 });
        // Falgun 1430 falls in leap 2024: 30 days, so 14 March is still Falgun.
        expect(toBangabda(2024, 3, 14)).toEqual({ year: 1430, month: 11, day: 30 });
        expect(toBangabda(2024, 3, 15)).toEqual({ year: 1430, month: 12, day: 1 });
    });

    it("keeps the national days on the dates the 2019 revision fixed", () => {
        // 21 February = 8 Falgun, 26 March = 12 Chaitra, 16 December = 1 Poush.
        for (const year of [2024, 2025, 2026, 2027]) {
            expect(toBangabda(year, 2, 21)).toMatchObject({ month: 11, day: 8 });
            expect(toBangabda(year, 3, 26)).toMatchObject({ month: 12, day: 12 });
            expect(toBangabda(year, 12, 16)).toMatchObject({ month: 9, day: 1 });
        }
    });

    it("writes Gregorian dates in Bangla", () => {
        expect(formatGregorianBangla(2023, 1, 31)).toBe(nfc("৩১ জানুয়ারি ২০২৩"));
    });
});

describe("message stamps in Bangladesh", () => {
    const moment = new Date("2026-11-12T08:05:00Z");

    it("add the Bangla date in Asia/Dhaka only", () => {
        expect(formatMessageTime(moment, "Asia/Dhaka")).toBe(
            `Thu 12 Nov 2026, 14:05 · ${nfc("২৭ কার্তিক ১৪৩৩")}`,
        );
        expect(formatMessageTime(moment, "Europe/London")).toBe("Thu 12 Nov 2026, 08:05");
    });
});
