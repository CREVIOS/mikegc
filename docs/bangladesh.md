# Spectre for Bangladesh

Spectre is set up for lawyers and in-house legal teams in Bangladesh. This page
explains what that changes, how to deploy it with OpenAI, every setting
involved, and the limits a lawyer should know before relying on it.

- [Deploying with OpenAI](#deploying-with-openai)
- [Bangladeshi law in answers](#bangladeshi-law-in-answers)
- [Laws of Bangladesh lookup](#laws-of-bangladesh-lookup)
- [Bangla text](#bangla-text)
- [Bangladesh workflows](#bangladesh-workflows)
- [Settings](#settings)
- [Limits and what to verify](#limits-and-what-to-verify)
- [Sources](#sources)

## Deploying with OpenAI

Spectre runs on OpenAI by default and keeps every other provider available.

1. Follow the [quick start](../README.md#quick-start) or
   [deployment guide](deployment.md).
2. Set `OPENAI_API_KEY` in `backend/.env`. No other model key is needed.
3. Start the stack. A new user can chat at once: nobody has to pick a model.

With only an OpenAI key, every surface runs on OpenAI:

| Surface | Model with nothing chosen |
| --- | --- |
| Chat, project chat, Word add-in, tabular chat | `gpt-6.1-sol` (or `SPECTRE_DEFAULT_MODEL`) |
| New tabular review, column-prompt drafting | `gpt-6.1-sol` (or `SPECTRE_DEFAULT_MODEL`) |
| Playbook import and review | `gpt-6.1-sol` (or `SPECTRE_DEFAULT_MODEL`) |
| Chat titles, light subagents | `gpt-6-luna` |
| Standard subagents | `gpt-6.1-sol` |
| Intake triage and agent | `gpt-6-luna` |
| Intake document preprocessing | `gpt-6.1-sol` |
| Memory curator | the chat's model, unless `MEMORY_CURATOR_MODEL` is set |
| Web search | OpenAI's built-in search, when the user turns web search on |

A saved choice always wins: the chat's model, then the user's last-selected
model. The default only fills the gap, and only with a model the user (or
their organization) holds a key for and is allowed to use. If the user has no
OpenAI key, the default falls through to Claude Sonnet, Gemini Flash, then
Mistral Medium, whichever they hold a key for. Users can still pick any model
in the composer, including Anthropic, Gemini, Mistral, routers, cloud
platforms, OpenAI-compatible endpoints and local Ollama models.

To make OpenAI's flagship the default, set `SPECTRE_DEFAULT_MODEL=gpt-6-astra`.

**OpenAI and client data.** OpenAI's API does not train on API data by default
and keeps abuse-monitoring logs for up to 30 days. Zero Data Retention needs
OpenAI's approval. OpenAI has no Bangladesh data-residency region; the nearest
are India and Singapore. Consider this against the Personal Data Protection
Act, 2026, which limits cross-border transfers of personal data, and agree it
with the client where needed.

## Bangladeshi law in answers

Unless a user's profile names another jurisdiction, the assistant works under
Bangladeshi law. It is told:

- the court system: Appellate and High Court Divisions, subordinate civil and
  criminal courts, and special tribunals including the Commercial Courts
  (Commercial Court Act, 2026); that Appellate Division decisions bind every
  court (Article 111); that Indian and Pakistani decisions are only
  persuasive; and to say "advocate", not "attorney";
- how to cite laws ("the Contract Act, 1872 (Act No. IX of 1872), section 23";
  "চুক্তি আইন, ১৮৭২ এর ধারা ২৩") and cases in DLR, BLD, BLC, MLR, ALR, LNJ,
  BLT, ADC, CLR and SCOB form, never inventing an authority, and never using
  CourtListener (United States case law) for Bangladesh;
- that the law changed heavily from August 2024: about 133 ordinances, most
  turned into Acts in April 2026, some repealed and 13 lapsed on 11 April 2026.
  It must check the current status of any law made or changed since 2024;
- transactional practice: stamp duty and non-judicial stamp paper (rates only
  from a current source), registration under section 17 of the Registration
  Act, 1908, notarisation, governing-law and arbitration choices, the Labour
  Act, and the cheque-dishonour timeline;
- litigation drafting: legal notices, plaints, written statements, writ
  petitions and affidavits;
- money in Taka with lakh and crore grouping, amounts repeated in words, and
  day-first dates;
- the Bar Council's canons and the Chief Justice's warning about unverified AI
  output: answers are drafts for an advocate to check.

The block is in `backend/src/lib/bangladesh/practicePrompt.ts`. It is added to
chat, project chat, Word chat and tabular chat. A user in another jurisdiction
(set in their profile) does not get it.

Tabular reviews read Bangladeshi documents correctly: amounts keep lakh/crore
grouping, Taka, Tk and ৳ are `[[BDT]]`, and Bangla dates and digits are
written as English dates and ASCII digits so columns sort and compare.

## Laws of Bangladesh lookup

The assistant can search and read the official text of Acts, Ordinances and
President's Orders on the [Laws of Bangladesh](https://bdlaws.minlaw.gov.bd)
website of the Legislative and Parliamentary Affairs Division:

- `bd_law_search` searches by title or subject, in English or Bangla, and marks
  repealed laws;
- `bd_law_read` reads an Act's table of contents, a section, a chapter or the
  whole Act, with its number, date, repeal status and amendment notes.

The answer shows these as "Searched the Laws of Bangladesh" and "Read" steps
with links, and cites each Act or section with a link to its page.

- The tools reach only `https://bdlaws.minlaw.gov.bd`, through the same
  SSRF guard as connectors, with redirects refused. Pages are cached for an
  hour per backend process. Each answer may search 10 times and read 20 pages.
- The site has no API. The client in `backend/src/lib/bdlaws.ts` reads its HTML
  and decodes its UTF-16 big-endian pages, which the site labels only as
  "UTF-16".
- The backend must be able to reach the site. If your network restricts
  outbound traffic, allow `bdlaws.minlaw.gov.bd`.
- The tools are on when the default jurisdiction is Bangladesh. Set
  `SPECTRE_BDLAWS_ENABLED=false` to turn them off.

## Bangla text

**Answers.** Users can choose বাংলা (Bangla) under Settings → Personalisation →
Response style, or write in Bangla to get Bangla answers. The assistant writes
standard Bangladeshi Bangla with Bangla Academy spelling, uses the established
legal terms, ends sentences with the dari (।), uses Bangla digits in Bangla
prose, and quotes documents exactly as written.

**Generated documents.** Word files give Bangla runs a Unicode Bangla font
(`SPECTRE_BANGLA_FONT`, Nirmala UI by default, which every Windows since 8 has)
as the complex-script font, tag them `bn-BD`, and size them like the Latin text
beside them. PowerPoint themes set the same font for Bangla. The backend image
installs Noto Sans and Serif Bengali, so Bangla in PDF previews converted by
LibreOffice renders instead of showing empty boxes.

**Reading documents.**

- *Unicode normalisation.* Stored document text and search queries are NFC,
  and find-in-document and quote checks compare canonically decomposed text.
  So য়, ড়, ঢ়, ো and ৌ match however they were typed, and zero-width joiners
  are ignored. Vowel signs and the hasanta are no longer dropped when quotes
  are compared, and quotes in Bangla are highlighted in the PDF and Word
  viewers.
- *Legacy Bijoy text.* Many government and court documents are typed with the
  Bijoy keyboard in SutonnyMJ and other "MJ" fonts, which store Bangla as Latin
  characters ("evsjv‡`k" for বাংলাদেশ). Spectre converts it to Unicode when it
  reads a document:
  - in Word files, runs whose font is an MJ font (directly, by character or
    paragraph style, or by the document's defaults) are converted;
  - in PDFs, which carry no reliable font name in their text, lines that look
    like Bijoy are converted, and every non-English line on a page that is
    clearly Bijoy throughout.

  The conversion is in `backend/src/lib/bangla/bijoy.ts`. Its glyph table
  follows the MIT-licensed bn-ansi-to-unicode package.
- *PDF visual order.* PDFs often store Bangla vowel signs in drawing order,
  so extracted text reads "িক" for কি. Spectre detects such pages and restores
  logical order.
- *Fonts in the browser.* The web app and Word add-in fall back to Noto Sans
  Bengali, Nirmala UI, Kohinoor Bangla, Kalpurush, SolaimanLipi or Nikosh for
  Bangla.

## Bangladesh workflows

[`workflows/bangladesh/`](../workflows/bangladesh/README.md) holds a workflow
pack laid out as the system workflows repository expects:

| Workflow | Type |
| --- | --- |
| Legal Notice (উকিল নোটিশ) | Assistant |
| Contract Review (Bangladesh) | Assistant |
| Employment Contract Review (Bangladesh) | Assistant |
| Plaint (আরজি) Draft | Assistant |
| Statute Check (Bangladesh) | Assistant |
| Legal Translation (Bangla ⇄ English) | Assistant |
| Cheque Dishonour (NI Act s.138) | Assistant |
| Data Protection Review (Bangladesh) | Assistant |
| Contract Compliance Review (Bangladesh) | Tabular review |

To install them, copy the pack's `assistant-workflows/bangladesh/` and
`tabular-review-workflows/bangladesh/` folders into your workflows repository
(a fork of `open-legal-products/mikegc-workflows`), point
`MIKE_WORKFLOWS_REPOSITORY` at it, and run the workflow sync. See
[Contributing](../CONTRIBUTING.md#system-workflows).
`backend/src/lib/__tests__/bangladeshWorkflows.test.ts` loads the pack through
the real catalog parser, so it is known to load.

## Settings

All are optional and go in `backend/.env`.

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | The deployment's OpenAI key. Users can also save their own. |
| `SPECTRE_DEFAULT_MODEL` | `gpt-6.1-sol` | The chat model a user with nothing saved starts on, if they can run it. |
| `SPECTRE_DEFAULT_JURISDICTION` | Bangladesh | The jurisdiction assumed when a user's profile names none. `none` turns the Bangladesh guidance off for them. |
| `SPECTRE_BANGLA_FONT` | Nirmala UI | The Unicode Bangla font for generated Word and PowerPoint files. MJ fonts are refused. |
| `SPECTRE_BDLAWS_ENABLED` | on for Bangladesh | `false` hides the Laws of Bangladesh tools; `true` offers them elsewhere. |

## Limits and what to verify

- **Answers are drafts.** Every answer, citation and document must be checked
  by an advocate before it is signed, sent or filed.
- **Case law.** Most Bangladeshi law reports (DLR, BLD, BLC and others) are in
  print or paid databases; only the Supreme Court's website and SCOB are free.
  Spectre cannot verify reporter citations and is told not to invent them.
- **Statutes.** The Laws of Bangladesh can lag behind the Bangladesh Gazette,
  and its repeal notes are not complete. Confirm recently made or amended law
  in the Gazette.
- **Stamp duty.** Rates change with Finance Acts. Spectre does not state a
  rate unless it found it in a current source.
- **Scanned documents.** There is no OCR yet. A scanned PDF is reported as
  having no text layer. Bangla OCR (Tesseract, or a vision model) is a
  candidate follow-up.
- **Editing Bijoy documents.** A Word file typed in an MJ font reads as Unicode
  Bangla, but its tracked edits must quote the file's own characters, so the
  assistant cannot edit those passages by quoting its Unicode reading. Convert
  the document to Unicode first.
- **Highlighting.** Highlighting a quote in a PDF whose text is stored in visual
  order, or in Bijoy, may not find the passage, because the viewer reads the
  PDF's own text.
- **Bangla calendar.** Bangla-calendar dates are written only when asked; the
  revised calendar fixes Pohela Boishakh on 14 April.

## Sources

The statute facts, URL structure and language rules come from research in
November 2026 against primary sources, including:

- [Laws of Bangladesh](https://bdlaws.minlaw.gov.bd), including the Personal
  Data Protection Act, 2026
  ([act-1692](https://bdlaws.minlaw.gov.bd/act-print-1692.html)), the Cyber
  Security Act, 2026 ([act-1710](https://bdlaws.minlaw.gov.bd/act-details-1710.html)),
  the Commercial Court Act, 2026 ([act-1652](https://bdlaws.minlaw.gov.bd/act-1652.html)),
  the Code of Civil Procedure amendment ([act-1531](https://bdlaws.minlaw.gov.bd/act-1531.html))
  and the Code of Criminal Procedure amendment
  ([act-1549](https://bdlaws.minlaw.gov.bd/act-1549.html));
- the Supreme Court's [judgments portal](https://www.supremecourt.gov.bd/web/?page=judgments.php&menu=00&div_id=1)
  and the Supreme Court Online Bulletin;
- the Bangladesh Bar Council's
  [canons of conduct](https://www.barcouncil.gov.bd/disciplinary-jurisdiction/conduct-of-ethics-of-lawyers/);
- reporting on the conversion of the interim government's ordinances
  ([The Daily Star](https://www.thedailystar.net/news/bangladesh/news/20-ordinances-lose-validity-4148621),
  [The Business Standard](https://www.tbsnews.net/bangladesh/91-bills-passed-convert-yunus-era-ordinances-laws-1408216));
- the Dhaka University law faculty's
  [citation guideline](https://law.du.ac.bd/en/wp-content/uploads/2017/08/Guideline-for-Reference.pdf);
- OpenAI's [supported countries](https://developers.openai.com/api/docs/supported-countries)
  and [data controls](https://developers.openai.com/api/docs/guides/your-data).
