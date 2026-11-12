---
name: "bd-contract-review"
description: "Review a contract or NDA for enforceability and risk under Bangladeshi law, and propose tracked changes."
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "English"
  mike-display-name: "Contract Review (Bangladesh)"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "General Transactions"
  jurisdictions: "Bangladesh"
---
# Contract Review (Bangladesh)

Review the attached contract (NDA, services, supply, distribution, lease, loan, or similar) for a party in Bangladesh. Ask which party the user acts for if it is not clear.

Check, citing the clause for each finding:

1. **Formation and validity.** Parties correctly described (company name as registered with the RJSC, trade licence or registration numbers where relevant), authority to sign, consideration, and lawful object (Contract Act, 1872, sections 10, 23-24).
2. **Restraints.** Non-compete, non-solicit and exclusivity clauses against section 27 of the Contract Act (agreements in restraint of trade are void, with narrow exceptions); clauses that bar legal proceedings or shorten limitation against section 28 (arbitration clauses are allowed).
3. **Damages and penalties.** Liquidated damages and penalty clauses against section 74 (only reasonable compensation is recoverable); caps, exclusions and indemnities.
4. **Governing law and disputes.** Is Bangladeshi law chosen? Courts at Dhaka or arbitration under the Arbitration Act, 2001 (seat, institution such as BIAC, rules, language, number of arbitrators)? For a foreign seat, note enforcement of the award in Bangladesh under section 45 of the Arbitration Act, 2001. Note whether the Commercial Court Act, 2026 may apply.
5. **Stamp duty and execution.** Whether the instrument needs stamping under the Stamp Act, 1899 and how (non-judicial stamp paper); an unstamped instrument is not admissible in evidence until duty and penalty are paid. Whether it must be registered under the Registration Act, 1908 (for example a lease of immovable property for more than a year, or a contract for the sale of immovable property). Do not state a stamp duty rate unless you confirm it from a current source.
6. **Data, confidentiality and electronic records.** Personal data clauses against the Personal Data Protection Act, 2026 (consent, purpose, security, cross-border transfer, breach notice); electronic signatures and records (Information and Communication Technology Act, 2006; Evidence Act, 1872 as amended in 2022).
7. **Tax and payments.** VAT and withholding (VAT and Supplementary Duty Act, 2012; Income Tax Act, 2023), payment currency and foreign exchange limits for cross-border payments (Foreign Exchange Regulation Act, 1947 and Bangladesh Bank rules).
8. **Language.** For a bilingual contract, is there a clause saying which version prevails, and do the two versions match?
9. **Termination, notices, force majeure, assignment and survival.**

Check every statute you rely on with the Laws of Bangladesh tools, especially anything made or changed from 2024 onward.

Then:
- Give a summary table: clause, issue, risk (High / Medium / Low), recommendation.
- Propose the changes as tracked edits to the document where the user wants a markup, keeping the document's language (Bangla clauses in Bangla).
- End with what the advocate must confirm: stamp duty and registration, current text of any recently amended law, and facts you assumed.
