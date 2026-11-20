/** Verbatim bank checklist, SHA-256 371160a9fa387a175f0a2cfbed013ba498fb7b9fa97897136c6945e843ab6429.
 * Matrix columns: combined, capacity only, governing law only. */
export const CORPORATE_LEGAL_INTRO = [
  "Should Include HSBC Bank (China) Company Limited and/or the relevant HBCN branch ",
  "Legal opinions should not restrict HBCN to disclose the same  (on a non-reliance basis, if required):\nto HBCN’s affiliates and their officers, directors, employees, auditors and professional advisers. \nto any potential transferees, sub-participants and assignees and to the professional advisors of each such person;\nas required in connection with, and for the purposes of, any litigation, arbitration, administrative or other investigations, proceedings or disputes; and\nas required by laws and/or regulations, a court order, the rules of any relevant stock exchange or if requested by any governmental, banking, taxation, regulatory or supervisory authority. ",
  "Check the list of documents which are being opined upon to ensure that all relevant documents are listed.",
  "Assumptions should limit to factual matters (not matters of law), which are outside the law firm’s knowledge and control. Do not accept an assumption that all representations or statements provided by an obligor (either in the facility letter or elsewhere) are correct or a matter which is within the external lawyer’s working scope, as that may cut across the legal opinion.  ",
  "Qualifications should limit to those based on the applicable laws and/or judicial practices, and should not conflict with or undermine the reliability of the opinions. ",
  "The legal opinion should not contain a limitation of liability. "
] as const;
export const CORPORATE_LEGAL_OPINIONS = [
  {
    "text": "1.  Obligor is duly incorporated and validly existing under local laws",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "text": "2. Searches – no appointment of liquidator or receiver",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "text": "3.  Obligor has the corporate power to execute the documents and perform its obligations",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "text": "4.  Obligor has the necessary corporate authorisation to execute the documents and perform its obligations under them",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "text": "5.  Documents have been duly executed by the obligor",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "text": "6.  Execution of the documents and performance of obligations \n(i) will not breach the laws of the obligor’s  incorporation location",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "text": "(ii) does / will not contravene obligor’s constitutional documents",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "text": "7.  Obligor’s obligations are legal, valid, binding and enforceable",
    "matrix": [
      "",
      "X",
      ""
    ]
  },
  {
    "text": "8.  No authorisations or consents etc are required to enable the obligor to execute the documents and perform its obligations",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "text": "9.  No stamp duty or registration taxes are payable in respect of any document (except as specifically listed)",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "text": "10.  No filings or registrations are required to ensure the enforceability of the financing documents s/enable the obligor to execute the documents or perform its obligations (except as specifically listed)",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "text": "11.  The security documents create valid security interests(subject to the security perfection requirement as specifically listed)",
    "matrix": [
      "",
      "X",
      ""
    ]
  },
  {
    "text": "12.  The documents contain a valid and binding choice of \n(i) governing law \n(ii) jurisdiction",
    "matrix": [
      "X",
      "",
      "X"
    ]
  },
  {
    "text": "13. Recognition and Enforcement of foreign judgment in local jurisdiction",
    "matrix": [
      "X",
      "",
      "X"
    ]
  },
  {
    "text": "14. No Finance Party is deemed to be domiciled or carrying on business",
    "matrix": [
      "Required if possible",
      "Required if possible",
      "Required if possible"
    ]
  },
  {
    "text": "15. No Finance Party is required to be licensed, qualified or entitled to carry on business",
    "matrix": [
      "Required if possible",
      "Required if possible",
      "Required if possible"
    ]
  },
  {
    "text": "16. No immunity from suit, execution, attachment or other legal process",
    "matrix": [
      "Required if possible",
      "Required if possible",
      "X"
    ]
  }
] as const;
export const CORPORATE_LEGAL_FOOTNOTES:Record<number,string> = {
  "18": "Applicable if the legal opinion opines on security documents.",
  "19": "Applicable if the obligor and governing law are in different jurisdictions.",
  "21": "Applicable in case of overseas legal opinion.",
  "22": "Applicable in case of overseas legal opinion.",
  "23": "Applicable in case of offshore obligor."
};
