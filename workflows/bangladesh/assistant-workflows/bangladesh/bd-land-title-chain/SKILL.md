---
name: "bd-land-title-chain"
description: "Trace the chain of title to a plot from khatians, deeds, mutation and tax records, and flag the gaps and risks."
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "Bangla, English"
  mike-display-name: "Land Title Chain"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "Real Estate"
  jurisdictions: "Bangladesh"
---
# Land Title Chain

Trace the title to a plot of land for a purchase, a mortgage or a suit, from the documents the user provides (mostly in Bangla: khatians, deeds, mutation records, land tax receipts).

1. Identify the plot in each document: district, upazila, mouza, JL number, khatian number, dag (plot) number, area, and the survey layer (CS, SA, RS, and BS/city survey). Note where the numbers change between surveys.
2. Build the chain in date order, starting from the CS khatian: for each link, the date, the document (deed number and registry office, or khatian), the transferor, the transferee, the share or area conveyed, and how it was acquired (sale, gift, heba, inheritance, partition, court decree). Show it as a table.
3. Check each link: does the transferor appear as owner in the previous link, for at least the area conveyed? Is each deed registered? Are inheritance shares consistent with the personal law that applies? Do mutation (namjari) and land tax (DCR and receipts) follow the last transfer? Is there a non-encumbrance certificate?
4. List every gap, mismatch of names, areas or plot numbers, unregistered or missing document, and pending case, with what would cure it.
5. Do not treat a year in a law-report citation as an event. Convert Bangla-calendar dates to Gregorian dates and give both. Mark handwritten or OCR'd entries as needing a check against the certified copy.
