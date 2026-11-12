---
name: "bd-plaint-draft"
description: "Draft a plaint for a civil suit in a Bangladeshi court under Order VII of the Code of Civil Procedure."
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "English"
  mike-display-name: "Plaint (আরজি) Draft"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "Litigation"
  jurisdictions: "Bangladesh"
---
# Plaint (আরজি) Draft

Draft a plaint for a civil suit before a Bangladeshi civil court, in Bangla unless the user asks for English.

1. From the user's message and documents, establish: the court with pecuniary and territorial jurisdiction (Assistant Judge, Senior Assistant Judge, Joint District Judge, or a special court), the plaintiffs and defendants, the cause of action and the date it arose, the reliefs, the valuation of the suit and the court fee, and any property schedule. Ask for missing essentials before drafting.
2. Check, with the Laws of Bangladesh tools, the provisions you rely on: Order VII rules 1-8 of the Code of Civil Procedure, 1908 as amended in 2025-2026 (the plaint must now give the parties' contact details and national identity numbers where the amendment requires them), the Specific Relief Act, 1877 for declarations and injunctions, the Court-fees Act, 1870 and the Suits Valuation Act, 1887, and the Limitation Act, 1908 for the period that applies.
3. Use the customary structure:
   - মোকাম (court), suit number placeholder (দেওয়ানী মোকদ্দমা নং ...), parties with father's or husband's name, address, NID, phone and email (বাদী / বিবাদী);
   - title of the suit and the statutory basis (for example "ঘোষণামূলক ও চিরস্থায়ী নিষেধাজ্ঞার প্রার্থনায় মোকদ্দমা");
   - numbered paragraphs: facts, cause of action and when it arose (নালিশের কারণ), jurisdiction, valuation and court fee (মূল্যমান ও কোর্ট ফি), limitation;
   - the prayers (প্রার্থনা), including costs and "any other relief";
   - the schedule of property (তফসিল) with mouza, JL number, khatian and dag numbers and boundaries where land is involved;
   - the verification (সত্যপাঠ) and the advocate's signature.
4. If interim relief is needed, add a separate application for a temporary injunction under Order XXXIX rules 1 and 2 (prima facie case, balance of convenience, irreparable loss).
5. Generate the plaint as a Word document. List what the advocate must verify: valuation and court fee, limitation, the parties' particulars, and the property schedule against the record of rights.
