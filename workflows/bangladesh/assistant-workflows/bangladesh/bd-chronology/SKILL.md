---
name: "bd-chronology"
description: "Build a dated chronology of a matter from its documents, in English or Bangla, ignoring law-report years."
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "English"
  mike-display-name: "Chronology"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "Litigation"
  jurisdictions: "Bangladesh"
---
# Chronology

Build a chronology of the matter from the documents provided.

1. Read every document. For each event, record: the date (day first), the event in one line, the people involved, and the source (document and page or paragraph). Order events by date; put undated events at the end.
2. Dates: convert Bangla digits and Bangla month names to a Gregorian date, and give a Bangla-calendar (বঙ্গাব্দ) date alongside where the document uses one ("১৭ মাঘ ১৪২৯ / 31 January 2023"). Mark approximate dates ("about March 2019") and conflicts between documents.
3. Ignore years that are part of a citation (for example "56 DLR (AD) 1" or "Act No. IX of 1872"): they are not events.
4. Present a table (Date | Event | Parties | Source), then a short list of gaps and inconsistencies a lawyer should check.
5. For a loan default, include sanction, disbursement, instalments due and missed, notices and rescheduling; for land, every transfer and record change; for a hearing, every adjournment and its reason.
