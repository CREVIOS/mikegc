---
name: "bd-legal-notice"
description: "Draft a Bangladeshi advocate's legal notice in Bangla or English from the facts and documents."
license: "Apache-2.0"
metadata:
  version: "1.0.0"
  author: "Spectre"
  language: "Bangla, English"
  mike-display-name: "Legal Notice (উকিল নোটিশ)"
  mike-type: "assistant"
  mike-availability: "system"
  practice: "Litigation"
  jurisdictions: "Bangladesh"
---
# Legal Notice (উকিল নোটিশ)

Draft a legal notice that a Bangladeshi advocate can sign and send on behalf of the client.

1. Work out from the user's message and the attached documents: the client (sender), the recipient and their address, the facts in date order, the legal basis of the claim, the demand, and any statutory notice the claim needs. Ask for anything essential that is missing (names, addresses, amounts, dates) before drafting, using ask_inputs if available.
2. Identify the governing law and check it with the Laws of Bangladesh tools before relying on it. Common bases: breach of contract (Contract Act, 1872, sections 73-74), dishonour of cheque (Negotiable Instruments Act, 1881, section 138, which has its own notice period), recovery of money, eviction of a tenant, defamation, consumer claims. Before suing the Government or a public officer, check whether section 80 of the Code of Civil Procedure, 1908 requires prior notice and say so.
3. Write the notice in the language the user asks for; default to Bangla for a recipient in Bangladesh and English for a foreign or corporate recipient that works in English. Use this structure:
   - Advocate's letterhead placeholder, reference number and date; "By Registered Post with A/D" (রেজিস্ট্রি ডাকযোগে প্রাপ্তি স্বীকারসহ) and email where known.
   - Recipient's name and address; subject line (বিষয়).
   - "Under instructions from and on behalf of my client ..." (আমার মক্কেল ... এর পক্ষে ও নির্দেশক্রমে ...), then the facts in numbered paragraphs, each tied to a document where possible.
   - The legal basis, the breach, and the precise demand (amount in figures and words, Taka with lakh/crore grouping), with a clear time limit (7, 15 or 30 days, or the statutory period).
   - The consequence: civil and/or criminal proceedings, with costs, if the demand is not met.
   - Signature block for the advocate (name, enrolment, chamber address) and a copy line for the client.
4. Keep the tone firm and professional; do not threaten anything unlawful, and do not overstate the claim.
5. Generate the notice as a Word document. After it, list in a short note what the advocate must verify before sending: names and addresses, amounts, dates, the statutory period, and any law you could not confirm on the Laws of Bangladesh.
