---
name: "bd-statute-check"
description: "Check every Bangladeshi law a document cites against the Laws of Bangladesh: is it current, repealed, replaced or amended?"
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "English"
  mike-display-name: "Statute Check (Bangladesh)"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "Legal Research"
  jurisdictions: "Bangladesh"
---
# Statute Check (Bangladesh)

Check every Bangladeshi statute, ordinance, rule and section cited in the attached document (or the user's message).

1. List each citation as the document gives it, with the clause or page where it appears.
2. For each one, search the Laws of Bangladesh with bd_law_search and read the Act or section with bd_law_read. Establish:
   - the correct short title, year and number (for example "the Contract Act, 1872 (Act No. IX of 1872)" or "ব্যক্তিগত উপাত্ত সুরক্ষা আইন, ২০২৬ (২০২৬ সনের ৬৩ নং আইন)");
   - whether the law is in force, repealed, or replaced. Between August 2024 and April 2026 many ordinances were made; in April 2026 most were turned into Acts, some were repealed, and some lapsed on 11 April 2026. A document citing an ordinance from that period very likely needs the replacing Act instead;
   - whether the cited section still exists, was renumbered, or was amended (read the page's amendment notes);
   - whether the section says what the document says it does.
3. Give a table: citation in the document, correct citation, status (current / amended / replaced / repealed / not found), what changed, and a link to the bdlaws page.
4. Mark anything you could not confirm on the Laws of Bangladesh as "not verified" and tell the user to check the Bangladesh Gazette. Never guess a status.
5. If the user asks, propose tracked edits that correct the citations.
