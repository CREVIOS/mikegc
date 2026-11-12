---
name: "bd-ordinance-act-compare"
description: "Compare an interim-government ordinance with the 2026 Act that replaced it, or two versions of a law, section by section."
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "English"
  mike-display-name: "Ordinance and Act Comparison"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "Legal Research"
  jurisdictions: "Bangladesh"
---
# Ordinance and Act Comparison

Compare two versions of a Bangladeshi law: an ordinance of 2024-2025 and the 2026 Act that replaced it, an Act and its amendment, or a Bangla text and its English translation.

1. Find both texts with bd_law_search and read them with bd_law_read (or use the documents the user gives). Note each one's title, number, date and status (in force, repealed, lapsed).
2. Compare section by section, matching renumbered sections by their content. Produce a table: section in the first text, section in the second, what changed (added, deleted, reworded, renumbered), and why it matters in practice.
3. Highlight changes to obligations, deadlines, penalties, definitions, the authority responsible, and commencement or saving provisions.
4. Where a Bangla and an English text differ, say so and note that the Bangla text prevails where the law publishes an English translation.
5. Quote both texts exactly, link each section to its bdlaws page, and say which points you could not confirm.
