// Bangladeshi dates: the Bangla calendar (বঙ্গাব্দ) and Bangla numerals.
//
// Bangladesh's revised calendar (in use since 16 October 2019) is fixed to
// the Gregorian one: Pohela Boishakh is always 14 April; Boishakh to Ashwin
// have 31 days; Kartik to Chaitra have 30, except Falgun, which has 29 days,
// or 30 when the Gregorian year it falls in is a leap year. Gazettes and
// court papers often print both dates ("১৭ মাঘ, ১৪২৯/৩১ জানুয়ারি, ২০২৩").
// West Bengal still uses the older calendar, so these dates are Bangladesh's.

import { asciiDigitsToBangla } from "../bangla/normalize";

export const BANGLA_MONTHS = [
    "বৈশাখ",
    "জ্যৈষ্ঠ",
    "আষাঢ়",
    "শ্রাবণ",
    "ভাদ্র",
    "আশ্বিন",
    "কার্তিক",
    "অগ্রহায়ণ",
    "পৌষ",
    "মাঘ",
    "ফাল্গুন",
    "চৈত্র",
].map((name) => name.normalize("NFC"));

export const GREGORIAN_MONTHS_BN = [
    "জানুয়ারি",
    "ফেব্রুয়ারি",
    "মার্চ",
    "এপ্রিল",
    "মে",
    "জুন",
    "জুলাই",
    "আগস্ট",
    "সেপ্টেম্বর",
    "অক্টোবর",
    "নভেম্বর",
    "ডিসেম্বর",
].map((name) => name.normalize("NFC"));

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BangabdaDate = { year: number; month: number; day: number };

/**
 * The Bangla-calendar date of a Gregorian calendar date (year, 1-12 month,
 * day), under Bangladesh's revised calendar. `month` is 1 (Boishakh) to 12.
 */
export function toBangabda(year: number, month: number, day: number): BangabdaDate {
    const onOrAfterNewYear = month > 4 || (month === 4 && day >= 14);
    const startYear = onOrAfterNewYear ? year : year - 1;
    let offset = Math.round(
        (Date.UTC(year, month - 1, day) - Date.UTC(startYear, 3, 14)) / DAY_MS,
    );
    // Falgun falls in February and March of the year after Pohela Boishakh.
    const lengths = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, isLeap(startYear + 1) ? 30 : 29, 30];
    let index = 0;
    while (offset >= lengths[index]) {
        offset -= lengths[index];
        index += 1;
    }
    return { year: startYear - 593, month: index + 1, day: offset + 1 };
}

/** "২৭ কার্তিক ১৪৩৩" for a Gregorian date. */
export function formatBangabda(year: number, month: number, day: number): string {
    const b = toBangabda(year, month, day);
    return `${asciiDigitsToBangla(String(b.day))} ${BANGLA_MONTHS[b.month - 1]} ${asciiDigitsToBangla(String(b.year))}`;
}

/** "১২ নভেম্বর ২০২৬" for a Gregorian date. */
export function formatGregorianBangla(year: number, month: number, day: number): string {
    return `${asciiDigitsToBangla(String(day))} ${GREGORIAN_MONTHS_BN[month - 1]} ${asciiDigitsToBangla(String(year))}`;
}

/** The time zone whose users get Bangla-calendar dates in their message stamps. */
export const BANGLADESH_TIME_ZONE = "Asia/Dhaka";
