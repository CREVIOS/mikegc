// Five corporate use cases for Bangladeshi firms and in-house teams, each a
// foreign-drafted document and the markup a Bangladeshi lawyer makes to it.
//
// They are the demo content for Spectre's Bangladesh workspace and the
// fixtures for docs/examples/bangladesh/. Every change cites the provision it
// rests on. Points that could not be confirmed from a primary or reliable
// source (stamp duty rates, some section numbers of the 2026 Acts) are drafted
// "at the rate then applicable" or left to the lawyer to confirm, as the
// cover notes say. Research sources are listed in docs/examples/bangladesh.

export type UseCaseEdit = {
    /** Exact text of the clause as the foreign party drafted it. */
    find: string;
    /** The lawyer's replacement. Unchanged words stay unmarked in the redline. */
    replace: string;
    /** Why, in one sentence, for the comment and the cover note. */
    reason: string;
    /** The Bangladeshi provision the change rests on. */
    provision: string;
};

export type UseCase = {
    id: string;
    title: string;
    /** Who the lawyer acts for. */
    actingFor: string;
    /** Why this work is common in Bangladesh now. */
    context: string;
    document: { title: string; parties: string; clauses: { heading: string; text: string }[] };
    edits: UseCaseEdit[];
    coverNote: string;
    /** What the lawyer must confirm before sending. */
    toConfirm: string[];
};

export const BANGLADESH_USE_CASES: UseCase[] = [
    {
        id: "facility-agreement",
        title: "Term facility agreement with an offshore lender",
        actingFor: "the Bangladeshi borrower",
        context:
            "Offshore and DFI lenders lend to Bangladeshi companies on English-law LMA-style documents; local counsel marks up the approvals, tax and security provisions. Invest Bangladesh replaced BIDA from 20 August 2026, and Bangladesh Bank consolidated its foreign-exchange rules on loans on 2 September 2026.",
        document: {
            title: "USD 25,000,000 Term Facility Agreement",
            parties: "Meghna Textiles PLC (Borrower) and Orient Capital Pte. Ltd. (Lender)",
            clauses: [
                {
                    heading: "4.1 Initial conditions precedent",
                    text: "The Borrower may not deliver the first Utilisation Request unless the Lender has received all of the documents listed in Schedule 2 in form and substance satisfactory to it.",
                },
                {
                    heading: "8.3 Default interest",
                    text: "If the Borrower fails to pay any amount on its due date, interest shall accrue on the overdue amount at 4% per annum above the rate otherwise applicable, compounded monthly.",
                },
                {
                    heading: "13.2 Tax gross-up",
                    text: "If a Tax Deduction is required by law, the amount of the payment due from the Borrower shall be increased to an amount which leaves the Lender with an amount equal to the payment which would have been due if no Tax Deduction had been required.",
                },
                {
                    heading: "18.6 Authorisations",
                    text: "No consent, approval, authorisation or registration of any governmental authority is required in connection with the entry into or performance of the Finance Documents.",
                },
                {
                    heading: "22.4 Registration of security",
                    text: "The Borrower shall procure that each Security Document is registered with any applicable authority within 60 days of its date.",
                },
            ],
        },
        edits: [
            {
                find: "No consent, approval, authorisation or registration of any governmental authority is required in connection with the entry into or performance of the Finance Documents.",
                replace:
                    "Save for the Authorisations listed in Part B of Schedule 2 (including the prior authorisation of Invest Bangladesh (formerly the Bangladesh Investment Development Authority) for the borrowing under this Agreement and any approval or reporting required by Bangladesh Bank under the Foreign Exchange Regulation Act, 1947 and the foreign exchange circulars then in force), each of which has been or will before the first Utilisation be obtained and is in full force and effect, no other consent, approval, authorisation or registration of any governmental authority is required in connection with the entry into or performance of the Finance Documents.",
                reason: "Foreign borrowing needs Invest Bangladesh authorisation and follows Bangladesh Bank's consolidated rules; the representation would be untrue without them.",
                provision: "Foreign Exchange Regulation Act, 1947, s.20(3); Bangladesh Bank consolidated rules on loans and guarantees (2 September 2026); Invest Bangladesh Act, 2026",
            },
            {
                find: "interest shall accrue on the overdue amount at 4% per annum above the rate otherwise applicable, compounded monthly.",
                replace:
                    "interest shall accrue on the overdue amount at 2% per annum above the rate otherwise applicable, calculated on a simple (non-compounding) basis, which the Parties agree is a reasonable pre-estimate of the Lender's additional funding cost.",
                reason: "Increased interest from default may be a penalty, recoverable only as reasonable compensation.",
                provision: "Contract Act, 1872, s.74 and its Explanation",
            },
            {
                find: "leaves the Lender with an amount equal to the payment which would have been due if no Tax Deduction had been required.",
                replace:
                    "leaves the Lender with an amount equal to the payment which would have been due if no Tax Deduction had been required. The Borrower shall make any Tax Deduction required under section 119 of the Income Tax Act, 2023 at the rate then applicable and deliver the certificate of deduction to the Lender within 30 days. The Lender shall, on request, provide a certificate of tax residence and co-operate in obtaining from the National Board of Revenue any exemption or reduced-rate certificate available under an applicable double taxation agreement, and no increased amount is payable to the extent a Tax Deduction would not have been required had the Lender done so.",
                reason: "Interest paid abroad bears withholding tax; treaty relief needs the lender's residence certificate and an NBR certificate.",
                provision: "Income Tax Act, 2023, ss.119 and 145",
            },
            {
                find: "The Borrower shall procure that each Security Document is registered with any applicable authority within 60 days of its date.",
                replace:
                    "The Borrower shall (a) within 21 days of the creation of each charge, file the prescribed particulars with the Registrar of Joint Stock Companies and Firms under section 159 of the Companies Act, 1994; (b) within three months of execution, present each mortgage deed for registration under the Registration Act, 1908; and (c) pay stamp duty under the Stamp Act, 1899 at the rate then applicable before execution or, for an instrument executed outside Bangladesh, within three months of its first receipt in Bangladesh.",
                reason: "A charge not filed within 21 days is void against the liquidator and creditors; mortgages must be registered and instruments stamped to be admissible.",
                provision: "Companies Act, 1994, s.159; Registration Act, 1908, s.23; Stamp Act, 1899, ss.18 and 35",
            },
        ],
        coverNote:
            "The representation on authorisations now names Invest Bangladesh, which replaced BIDA from 20 August 2026, and Bangladesh Bank's consolidated foreign-exchange rules of 2 September 2026: without those authorisations both drawdown and repayment remittances are at risk. The security covenant now follows the 21-day RJSC filing period in section 159 of the Companies Act, 1994, because a charge filed late is void against a liquidator, and the registration and stamping steps under the Registration Act and the Stamp Act. Default interest is a simple 2% margin: section 74 of the Contract Act treats increased interest on default as a possible penalty. The tax clause keeps the gross-up but requires the Lender's help with treaty relief.",
        toConfirm: [
            "Stamp duty on the mortgage and other security at the current Finance Act rates (drafted \"at the rate then applicable\").",
            "Whether the lender's jurisdiction has a double taxation agreement with Bangladesh and the reduced rate.",
            "The exact Schedule 2 list of Invest Bangladesh and Bangladesh Bank authorisations for this borrowing.",
        ],
    },
    {
        id: "vendor-msa",
        title: "Telecom vendor master services agreement",
        actingFor: "the Bangladeshi telecom operator (customer)",
        context:
            "Operators and banks buy network equipment, software and cloud services from foreign vendors on vendor paper. Every payment raises VAT and income tax deduction at source, and the 2026 data protection law limits where personal data may be held.",
        document: {
            title: "Master Services and Supply Agreement",
            parties: "Padma Telecom Limited (Customer) and Northwind Networks Inc. (Supplier)",
            clauses: [
                {
                    heading: "5.5 Delivery",
                    text: "Supplier shall deliver the Equipment DDP to Customer's Dhaka warehouse in accordance with the Delivery Schedule.",
                },
                {
                    heading: "7.4 Taxes",
                    text: "All Fees are exclusive of Taxes. Customer shall pay all invoiced amounts in full without set-off, counterclaim or deduction of any kind, and if any withholding is required by law Customer shall gross up the payment so that Supplier receives the full invoiced amount.",
                },
                {
                    heading: "12.3 Data location",
                    text: "Supplier and its Affiliates and Subprocessors may store, process and access Customer Data in any country in which they maintain facilities.",
                },
                {
                    heading: "18.2 Time for claims",
                    text: "Any claim arising under this Agreement must be brought within twelve (12) months after the cause of action arises, failing which it shall be deemed irrevocably waived.",
                },
            ],
        },
        edits: [
            {
                find: "Customer shall pay all invoiced amounts in full without set-off, counterclaim or deduction of any kind, and if any withholding is required by law Customer shall gross up the payment so that Supplier receives the full invoiced amount.",
                replace:
                    "Customer shall (a) deduct VAT at source under section 49 of the Value Added Tax and Supplementary Duty Act, 2012, or account for VAT on imported services, and (b) deduct income tax at source under section 89, 90 or 119 (as applicable) of the Income Tax Act, 2023, in each case at the rate then applicable. Amounts so deducted and deposited shall be treated as paid to Supplier, and Customer shall furnish the Mushak-6.6 and income tax deduction certificates. No gross-up shall apply.",
                reason: "The customer is jointly liable for VAT it fails to deduct and loses the expense deduction if it fails to deduct income tax.",
                provision: "VAT and Supplementary Duty Act, 2012, s.49; Income Tax Act, 2023, ss.89, 90, 119 and 55",
            },
            {
                find: "Supplier and its Affiliates and Subprocessors may store, process and access Customer Data in any country in which they maintain facilities.",
                replace:
                    "Supplier shall store and process Customer Data that is confidential or restricted personal data under applicable Bangladeshi data protection law, and all subscriber data, only on infrastructure located in Bangladesh. Supplier may transfer other Customer personal data outside Bangladesh only with Customer's prior written approval, to a recipient and country that satisfy applicable Bangladeshi data protection law, and after any approval the law requires has been obtained. Supplier shall notify Customer of any personal data breach without undue delay and in any event within 24 hours.",
                reason: "Confidential and restricted personal data must be held in Bangladesh, and other transfers need a lawful basis and an adequate destination.",
                provision: "Personal Data Protection Act, 2026 (data classification and cross-border transfer provisions)",
            },
            {
                find: "Any claim arising under this Agreement must be brought within twelve (12) months after the cause of action arises, failing which it shall be deemed irrevocably waived.",
                replace:
                    "Each Party shall notify the other of any claim within a reasonable time after becoming aware of it. Nothing in this Agreement limits the time within which either Party may commence proceedings under applicable law.",
                reason: "A clause limiting the time to enforce rights in the ordinary courts is void.",
                provision: "Contract Act, 1872, s.28",
            },
            {
                find: "in accordance with the Delivery Schedule.",
                replace:
                    "in accordance with the Delivery Schedule. Supplier shall ensure that all Equipment imported for delivery is covered by a valid BTRC vendor enlistment and shipment-specific No Objection Certificate, and any delay or cost resulting from the absence of such an approval is at Supplier's risk.",
                reason: "Telecom equipment needs BTRC vendor enlistment and a no-objection certificate for each shipment.",
                provision: "Bangladesh Telecommunication Regulatory Commission import requirements",
            },
        ],
        coverNote:
            "The tax clause now has you deduct VAT at source and income tax at source as the law requires, with no gross-up: under the VAT and Supplementary Duty Act, 2012 you are jointly liable for VAT you fail to deduct, and under the Income Tax Act, 2023 the expense is disallowed if tax is not deducted. The data clause keeps confidential and restricted personal data, and all subscriber data, in Bangladesh, as the 2026 data protection law requires. The 12-month claims bar is deleted because section 28 of the Contract Act makes it void. BTRC import approvals are now the Supplier's responsibility.",
        toConfirm: [
            "VAT and income tax deduction rates for each service line (drafted \"at the rate then applicable\").",
            "Section numbers of the Personal Data Protection Act, 2026 as gazetted, and any regulations on transfer destinations.",
        ],
    },
    {
        id: "appointment-letter",
        title: "Appointment letter for a multinational's Dhaka subsidiary",
        actingFor: "the employer",
        context:
            "Group templates drafted abroad meet the Bangladesh Labour Act, 2006 as amended in 2026, whose definition of \"worker\" covers skilled, technical, clerical and sales staff whatever their designation; only managerial and administrative roles are outside it.",
        document: {
            title: "Letter of Appointment: Senior Sales Executive",
            parties: "Brightwave Bangladesh Limited (Company) and the Employee",
            clauses: [
                {
                    heading: "3.1 Probation",
                    text: "You will be on probation for six (6) months, which the Company may extend at its sole discretion.",
                },
                {
                    heading: "9.1 Termination",
                    text: "Your employment is at will and may be terminated by either party at any time by giving thirty (30) days' written notice or payment of basic salary in lieu.",
                },
                {
                    heading: "14.1 Non-competition",
                    text: "For twelve (12) months after the termination of your employment, you shall not be employed by or engaged in any business that competes with the Company or its Group in Bangladesh, India or Singapore.",
                },
                {
                    heading: "20.1 Governing law",
                    text: "This letter is governed by the laws of the Republic of Singapore.",
                },
            ],
        },
        edits: [
            {
                find: "You will be on probation for six (6) months, which the Company may extend at its sole discretion.",
                replace:
                    "You will be on probation for the period that applies to your role under section 4 of the Bangladesh Labour Act, 2006, extendable only as that section permits. If you are not notified otherwise when probation ends, you shall be deemed confirmed.",
                reason: "Probation is six months for clerical work and three months for other workers, and may be extended only as the Act allows.",
                provision: "Bangladesh Labour Act, 2006, s.4",
            },
            {
                find: "Your employment is at will and may be terminated by either party at any time by giving thirty (30) days' written notice or payment of basic salary in lieu.",
                replace:
                    "After confirmation, the Company may terminate your employment otherwise than by way of dismissal by giving you one hundred and twenty (120) days' written notice or wages in lieu, and shall pay the compensation and other dues required by section 26 of the Bangladesh Labour Act, 2006. You may resign by giving sixty (60) days' written notice under section 27 of that Act and shall receive the benefits that section provides.",
                reason: "A permanent monthly-rated worker is entitled to 120 days' notice and service-based compensation; resignation needs 60 days' notice.",
                provision: "Bangladesh Labour Act, 2006, ss.26 and 27",
            },
            {
                find: "For twelve (12) months after the termination of your employment, you shall not be employed by or engaged in any business that competes with the Company or its Group in Bangladesh, India or Singapore.",
                replace:
                    "During your employment, including any notice period, you shall not without the Company's written consent be engaged in any business that competes with the Company. Your obligations of confidentiality under Clause 13 continue after your employment ends without limit of time.",
                reason: "A restraint on working after employment ends is void; in-employment duties and confidentiality are enforceable.",
                provision: "Contract Act, 1872, s.27",
            },
            {
                find: "This letter is governed by the laws of the Republic of Singapore.",
                replace:
                    "This letter is governed by the laws of Bangladesh. Nothing in it reduces any right or benefit to which you are entitled under the Bangladesh Labour Act, 2006 or the rules made under it.",
                reason: "The employee works in Bangladesh, where the Labour Act's minimum standards apply.",
                provision: "Bangladesh Labour Act, 2006",
            },
        ],
        coverNote:
            "A Senior Sales Executive is very likely a \"worker\" under the 2026 definition, whatever the title. For workers, \"at will\" termination on 30 days' notice is not lawful: section 26 requires 120 days' notice (or wages in lieu) and compensation based on service, and section 27 gives a 60-day resignation period. Probation now follows section 4. The post-employment non-compete is replaced with an in-employment restriction and continuing confidentiality, because section 27 of the Contract Act makes a post-employment restraint void. Governing law is Bangladeshi.",
        toConfirm: [
            "Whether the role is genuinely managerial or administrative (outside the Labour Act's definition of worker), which changes the termination terms.",
            "The Company's permanent headcount, which decides provident fund and workers' participation fund obligations under the 2026 amendments.",
        ],
    },
    {
        id: "distribution-agreement",
        title: "Exclusive distribution agreement with a foreign principal",
        actingFor: "the Bangladeshi distributor",
        context:
            "Foreign FMCG, pharmaceutical and industrial brands enter Bangladesh through local distributors on the principal's template, which routinely carries post-term non-competes, termination for convenience, resale price control and time bars.",
        document: {
            title: "Exclusive Distribution Agreement",
            parties: "Lumen Consumer Brands S.A. (Principal) and Karnaphuli Trading Limited (Distributor)",
            clauses: [
                {
                    heading: "6.4 Minimum purchases",
                    text: "If Distributor fails to achieve the Minimum Annual Purchase Target, Distributor shall pay Principal, as liquidated damages, an amount equal to 100% of the shortfall.",
                },
                {
                    heading: "8.2 Resale prices",
                    text: "Distributor shall resell the Products only at the prices set out in Principal's current price list and shall not offer discounts without Principal's prior written consent.",
                },
                {
                    heading: "11.1 Non-competition",
                    text: "During the Term and for two (2) years thereafter, Distributor shall not directly or indirectly manufacture, import, distribute or promote any product that competes with the Products anywhere in Bangladesh.",
                },
                {
                    heading: "16.2 Termination for convenience",
                    text: "Principal may terminate this Agreement for convenience at any time on thirty (30) days' written notice, without liability for any compensation, indemnity or loss of goodwill.",
                },
                {
                    heading: "21.1 Arbitration",
                    text: "Any dispute shall be finally resolved by arbitration under the SIAC Rules seated in Singapore. No claim may be brought more than six (6) months after it arose.",
                },
            ],
        },
        edits: [
            {
                find: "If Distributor fails to achieve the Minimum Annual Purchase Target, Distributor shall pay Principal, as liquidated damages, an amount equal to 100% of the shortfall.",
                replace:
                    "If Distributor fails to achieve the Minimum Annual Purchase Target in two consecutive Contract Years, Principal's sole remedy shall be to make Distributor's appointment non-exclusive or to terminate this Agreement on ninety (90) days' notice.",
                reason: "A 100% shortfall payment is a penalty, recoverable only as reasonable compensation.",
                provision: "Contract Act, 1872, s.74",
            },
            {
                find: "Distributor shall resell the Products only at the prices set out in Principal's current price list and shall not offer discounts without Principal's prior written consent.",
                replace: "Principal may issue recommended resale prices. Distributor is free to determine its own resale prices.",
                reason: "Resale price maintenance is a listed anti-competitive practice.",
                provision: "Competition Act, 2012, s.15",
            },
            {
                find: "During the Term and for two (2) years thereafter, Distributor shall not directly or indirectly manufacture, import, distribute or promote any product that competes with the Products anywhere in Bangladesh.",
                replace:
                    "During the Term, Distributor shall not directly or indirectly import or distribute in the Territory any product that competes with the Products.",
                reason: "A restraint after the agreement ends is void; exclusivity during the term is kept.",
                provision: "Contract Act, 1872, s.27",
            },
            {
                find: "Principal may terminate this Agreement for convenience at any time on thirty (30) days' written notice, without liability for any compensation, indemnity or loss of goodwill.",
                replace:
                    "Either Party may terminate this Agreement for convenience on not less than six (6) months' written notice. On termination by Principal other than for Distributor's material breach, Principal shall repurchase saleable inventory at Distributor's landed cost and compensate Distributor for documented unrecovered investment made at Principal's request.",
                reason: "Thirty days with no compensation leaves the distributor with stranded stock and investment; reasonable notice and a buy-back are standard.",
                provision: "Contract Act, 1872, ss.205 and 206 (by analogy for a buy-sell distributor)",
            },
            {
                find: "seated in Singapore. No claim may be brought more than six (6) months after it arose.",
                replace:
                    "seated in Singapore. Nothing in this Clause prevents either Party from seeking interim or conservatory relief from a court of competent jurisdiction, including the courts of Bangladesh to the extent available under the Arbitration Act, 2001.",
                reason: "The six-month time bar is void, and the courts' power to grant interim relief for a foreign-seated arbitration is unsettled, so it is preserved expressly.",
                provision: "Contract Act, 1872, s.28; Arbitration Act, 2001, ss.3, 7A and 45",
            },
        ],
        coverNote:
            "The two-year post-term non-compete is void under section 27 of the Contract Act, so only in-term exclusivity is kept. The 100% shortfall payment would be cut down to reasonable compensation under section 74, and resale price control is an anti-competitive practice listed in section 15 of the Competition Act, 2012; both are replaced. Termination for convenience now needs six months' notice with a stock buy-back. SIAC arbitration stays, the six-month time bar is removed (void under section 28), and access to Bangladeshi courts for interim relief is preserved.",
        toConfirm: [
            "Whether the arrangement is a true agency (sections 205 and 206 of the Contract Act apply directly) or buy-sell distribution.",
            "Indenting registration and Bangladesh Bank requirements if the Distributor also acts as indenting agent.",
        ],
    },
    {
        id: "shareholders-agreement",
        title: "Shareholders' agreement with a foreign investor",
        actingFor: "the Bangladeshi company and its promoters",
        context:
            "Foreign investors take minority stakes in Bangladeshi private companies under shareholders' agreements. Bangladesh Bank's FEID Circular No. 01 of 8 March 2026 requires non-resident share transfers to be at fair value, with valuation and reporting rules.",
        document: {
            title: "Shareholders' Agreement",
            parties: "Sundarban Foods Limited (Company), its Promoters, and Delta Growth Fund L.P. (Investor)",
            clauses: [
                {
                    heading: "7.5 Transfers to Affiliates",
                    text: "The Investor may transfer any of its Shares to an Affiliate at any time without the consent of any other Shareholder.",
                },
                {
                    heading: "9.1 Put option",
                    text: "At any time after the fifth anniversary of Completion, the Investor may require the Promoters to purchase all of the Investor Shares at a price equal to the Subscription Price plus an internal rate of return of 15% per annum, payable in US Dollars to an account nominated by the Investor outside Bangladesh.",
                },
                {
                    heading: "12.1 Promoter non-competition",
                    text: "Each Promoter shall not, for three (3) years after ceasing to hold Shares, engage in any business competing with the Company anywhere in the world.",
                },
                {
                    heading: "25.3 Articles of association",
                    text: "In the event of any conflict between this Agreement and the Articles, this Agreement shall prevail as between the Shareholders, and the Shareholders shall procure the amendment of the Articles as necessary.",
                },
            ],
        },
        edits: [
            {
                find: "at any time without the consent of any other Shareholder.",
                replace:
                    "at any time without the consent of any other Shareholder, provided that the transfer is made at fair value as Bangladesh Bank regulations require, is recorded by filing Form 117 with the Registrar of Joint Stock Companies and Firms, is stamped at the rate then applicable under the Stamp Act, 1899, and the transferee first executes a Deed of Adherence.",
                reason: "Non-resident share transfers must be at fair value and are recorded by Form 117; the transfer instrument bears stamp duty.",
                provision: "Bangladesh Bank FEID Circular No. 01 (8 March 2026); Companies Act, 1994; Stamp Act, 1899",
            },
            {
                find: "at a price equal to the Subscription Price plus an internal rate of return of 15% per annum, payable in US Dollars to an account nominated by the Investor outside Bangladesh.",
                replace:
                    "at a price equal to the fair value of the Investor Shares on the exercise date, determined by an independent valuer using a valuation method accepted by Bangladesh Bank. The price shall be paid in Taka and repatriated through an authorised dealer in accordance with FEID Circular No. 01 dated 8 March 2026 (or any replacement), subject to Bangladesh Bank approval where required.",
                reason: "A guaranteed-return price may depart from fair value, so the authorised dealer could refuse repatriation without Bangladesh Bank approval.",
                provision: "Bangladesh Bank FEID Circular No. 01 (8 March 2026); Foreign Exchange Regulation Act, 1947",
            },
            {
                find: "Each Promoter shall not, for three (3) years after ceasing to hold Shares, engage in any business competing with the Company anywhere in the world.",
                replace:
                    "Each Promoter who sells Shares to the Investor under this Agreement shall not, for two (2) years after that sale, carry on in Bangladesh a business similar to the Business, so long as the Investor or its successor carries on a like business there.",
                reason: "A worldwide restraint is void; only a restraint tied to the sale of goodwill, within local limits, can be saved.",
                provision: "Contract Act, 1872, s.27, Exception 1",
            },
            {
                find: "In the event of any conflict between this Agreement and the Articles, this Agreement shall prevail as between the Shareholders, and the Shareholders shall procure the amendment of the Articles as necessary.",
                replace:
                    "Within thirty (30) days after Completion, the Shareholders shall pass a special resolution adopting amended Articles that incorporate the reserved matters, transfer restrictions, right of first refusal, tag-along and drag-along provisions of this Agreement, and the Company shall file them with the Registrar of Joint Stock Companies and Firms. Until then, this Agreement shall prevail as between the Shareholders.",
                reason: "Investor protections bind the company only once they are in its Articles; a contract between shareholders does not bind the company's statutory powers.",
                provision: "Companies Act, 1994",
            },
        ],
        coverNote:
            "The 15% guaranteed-return put conflicts with Bangladesh Bank's fair-value rule for non-resident share transfers (FEID Circular No. 01 of 8 March 2026), so repatriation could be refused or delayed; it is now a fair-value put paid in Taka and repatriated through an authorised dealer. Affiliate transfers must also be at fair value, recorded on Form 117 and stamped. The investor's protections bind the Company only once they are in the Articles, so the Shareholders now covenant to adopt and file them. The worldwide promoter non-compete is narrowed to the goodwill-sale exception in section 27 of the Contract Act.",
        toConfirm: [
            "Stamp duty on the share transfer at the current rate (reported as 1.5% of consideration for unlisted shares; drafted \"at the rate then applicable\").",
            "Whether Invest Bangladesh clearance is needed for this investment.",
        ],
    },
];
