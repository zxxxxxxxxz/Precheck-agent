// Bank requirement text and source positions; examples are not accepted answers.
export const PERSONAL_FIELDS = [
  {
    "row": 4,
    "id": "pg_field_4",
    "group": "guarantee",
    "label": "银行",
    "meaning": "授信银行名称",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 5,
    "id": "pg_field_5",
    "group": "guarantee",
    "label": "保证人",
    "meaning": "担保人名称",
    "requirement": "必需；可能存在一个或多个保证人的情况",
    "location": "P1"
  },
  {
    "row": 6,
    "id": "pg_field_6",
    "group": "guarantee",
    "label": "主债务人",
    "meaning": "借款人名称",
    "requirement": "必需；可能存在一个或多个主债务人的情况",
    "location": "P1"
  },
  {
    "row": 7,
    "id": "pg_field_7",
    "group": "guarantee",
    "label": "金额",
    "meaning": "担保金额",
    "requirement": "非无限额责任担保，则需有担保金额",
    "location": "P1"
  },
  {
    "row": 8,
    "id": "pg_field_8",
    "group": "guarantee",
    "label": "3. 第二自然段整段\n自本保证书签订日起届满X之日，以及改日之后每届满X之日",
    "meaning": "配套新本票需提交的日期",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 9,
    "id": "pg_field_9",
    "group": "guarantee",
    "label": "19. 依X法律解释",
    "meaning": "担保文件适用法律",
    "requirement": "必需",
    "location": "P3"
  },
  {
    "row": 10,
    "id": "pg_field_10",
    "group": "guarantee",
    "label": "日期",
    "meaning": "担保签署日",
    "requirement": "必需；需保留原日期，换算并备注中国日期",
    "location": "P4"
  },
  {
    "row": 11,
    "id": "pg_field_11",
    "group": "guarantee",
    "label": "银行同意签章",
    "meaning": "银行方签署",
    "requirement": "台湾法下担保为必需",
    "location": "P4"
  },
  {
    "row": 12,
    "id": "pg_field_12",
    "group": "guarantee",
    "label": "保证人签署",
    "meaning": "担保人签署",
    "requirement": "必需；一人保证则一人签署；若是多人保证，会存在多个保证人签署",
    "location": "P4"
  },
  {
    "row": 13,
    "id": "pg_field_13",
    "group": "guarantee",
    "label": "姓名",
    "meaning": "担保人名称",
    "requirement": "必需；若是多人保证，会存在多个保证人姓名",
    "location": "P4"
  },
  {
    "row": 14,
    "id": "pg_field_14",
    "group": "guarantee",
    "label": "身份证号码",
    "meaning": "担保人身份证号",
    "requirement": "必需；若是多人保证，会存在多个保证人身份证号码",
    "location": "P4"
  },
  {
    "row": 15,
    "id": "pg_field_15",
    "group": "guarantee",
    "label": "地址",
    "meaning": "担保人地址",
    "requirement": "必需；若是多人保证，会存在多个保证人地址",
    "location": "P4"
  },
  {
    "row": 17,
    "id": "pg_field_17",
    "group": "note",
    "label": "金额",
    "meaning": "担保的金额",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 18,
    "id": "pg_field_18",
    "group": "note",
    "label": "发票日",
    "meaning": "签署日期",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 19,
    "id": "pg_field_19",
    "group": "note",
    "label": "给付日",
    "meaning": "给付日期",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 20,
    "id": "pg_field_20",
    "group": "note",
    "label": "给付金额",
    "meaning": "给付的金额",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 21,
    "id": "pg_field_21",
    "group": "note",
    "label": "银行名称",
    "meaning": "贷款人名称",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 22,
    "id": "pg_field_22",
    "group": "note",
    "label": "发票人签署",
    "meaning": "担保人签署",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 23,
    "id": "pg_field_23",
    "group": "note",
    "label": "地址",
    "meaning": "担保人地址",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 24,
    "id": "pg_field_24",
    "group": "note",
    "label": "以X法律为准据法",
    "meaning": "文件适用法律",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 26,
    "id": "pg_field_26",
    "group": "authorization",
    "label": "银行",
    "meaning": "银行名称",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 27,
    "id": "pg_field_27",
    "group": "authorization",
    "label": "日期",
    "meaning": "签署日期",
    "requirement": "必需；需保留原日期，换算并备注中国日期",
    "location": "P1"
  },
  {
    "row": 28,
    "id": "pg_field_28",
    "group": "authorization",
    "label": "立书人",
    "meaning": "担保人",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 29,
    "id": "pg_field_29",
    "group": "authorization",
    "label": "依X法律解释",
    "meaning": "文件适用法律",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 30,
    "id": "pg_field_30",
    "group": "authorization",
    "label": "立书人签署",
    "meaning": "担保人签署",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 31,
    "id": "pg_field_31",
    "group": "authorization",
    "label": "姓名",
    "meaning": "担保人姓名",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 32,
    "id": "pg_field_32",
    "group": "authorization",
    "label": "职衔",
    "meaning": "担保人职衔",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 33,
    "id": "pg_field_33",
    "group": "authorization",
    "label": "身份证字号",
    "meaning": "担保人身份证号码",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 34,
    "id": "pg_field_34",
    "group": "authorization",
    "label": "住址",
    "meaning": "担保人地址",
    "requirement": "必需",
    "location": "P2"
  },
  {
    "row": 35,
    "id": "pg_field_35",
    "group": "authorization",
    "label": "背书人",
    "meaning": "",
    "requirement": "",
    "location": "P2"
  },
  {
    "row": 37,
    "id": "pg_field_37",
    "group": "legal",
    "label": "全文",
    "meaning": "",
    "requirement": "必需",
    "location": "全文"
  },
  {
    "row": 39,
    "id": "pg_field_39",
    "group": "identity",
    "label": "国别",
    "meaning": "",
    "requirement": "必需",
    "location": "P1"
  },
  {
    "row": 40,
    "id": "pg_field_40",
    "group": "identity",
    "label": "其他信息",
    "meaning": "",
    "requirement": "必需",
    "location": "P1"
  }
] as const;
export const PERSONAL_RULE_ROWS = [
  {
    "row": 4,
    "group": "guarantee",
    "label": "银行",
    "requirement": "须完整填写银行名称，可以是总行，也可为分支行。 \n若为分支行，通常与授信函中的贷款人一致",
    "notice": "若不一致，提示人工判断。"
  },
  {
    "row": 5,
    "group": "guarantee",
    "label": "保证人",
    "requirement": "1.在授信函中找出“由XXX 出具的担保”，对比两者名称一致，且\n2. 与担保人身份证明文件中的名称一致\n\n 请注意有可能存在多个保证人的情况。 ",
    "notice": "并未提供授信函（包括提供的文件为非授信函的其他授信文件），需提示人工判断；\n若不一致，需提示怎样不一致并提示人工判断。"
  },
  {
    "row": 6,
    "group": "guarantee",
    "label": "主债务人",
    "requirement": "需与授信函或客户官方注册文件（如注册登记证、章程、周年申报表）中的客户名称一致\n\n请注意有可能存在多个主债务人的情况。 ",
    "notice": "并未提供授信函（包括提供的文件为非授信函的其他授信文件），需提示人工判断；\n若不一致，需提示怎样不一致并提示人工判断。"
  },
  {
    "row": 7,
    "group": "guarantee",
    "label": "金额",
    "requirement": "不少于用户提供的金额",
    "notice": "若用户未提供，则在审查结果中列示，提醒用户判断是否符合要求"
  },
  {
    "row": 8,
    "group": "guarantee",
    "label": "3. 第二自然段整段\n自本保证书签订日起届满X之日，以及改日之后每届满X之日",
    "requirement": "无",
    "notice": "提示该段内容，提醒人工判断本票更新日期"
  },
  {
    "row": 9,
    "group": "guarantee",
    "label": "19. 依X法律解释",
    "requirement": "无",
    "notice": "提示用户适用法律，提醒人工判断担保人是否适用该法律"
  },
  {
    "row": 10,
    "group": "guarantee",
    "label": "日期",
    "requirement": "不晚于当前日期（即不能填写未来日期），台湾法下，该日期为民国日期, 需先换算成中国日期",
    "notice": "若晚于当前日期，提示该日期不合理\n"
  },
  {
    "row": 11,
    "group": "guarantee",
    "label": "银行同意签章",
    "requirement": "由客户经理签署，该字段不能为空",
    "notice": "若无，提示无银行同意签字，需要补充"
  },
  {
    "row": 12,
    "group": "guarantee",
    "label": "保证人签署",
    "requirement": "该字段不能为空，若为多个保证人，则多个保证人均需签署",
    "notice": "若无，提示无保证人签署，需要补充；若缺失某个保证人签署，则提示哪个保证人签署需要补充"
  },
  {
    "row": 13,
    "group": "guarantee",
    "label": "姓名",
    "requirement": "与担保人身份证明文件中名称一致；若为多个保证人，则多个保证人均需填写",
    "notice": "若无，提示无保证人姓名，需要补充；若缺失某个保证人姓名，则提示哪个保证人姓名需要补充"
  },
  {
    "row": 14,
    "group": "guarantee",
    "label": "身份证号码",
    "requirement": "与担保人身份证明文件一致；若为多个保证人，则多个保证人均需填写，匹配姓名后再核对身份证号码",
    "notice": "若无，提示无保证人身份证号码，需要补充；若缺失某个保证人身份证号码，则提示哪个保证人身份证号码需要补充"
  },
  {
    "row": 15,
    "group": "guarantee",
    "label": "地址",
    "requirement": "与证明文件上一致；若为多个保证人，则多个保证人均需填写",
    "notice": "若不一致，提示怎样不一致，并提示需更正或由客户经理合理澄清。"
  },
  {
    "row": 16,
    "group": "guarantee",
    "label": "个人保证书版本",
    "requirement": "",
    "notice": "需由台湾客户经理确认签署的保证书为台湾法下的标准版本，若为非标版本，需提供当地法务的确认"
  },
  {
    "row": 19,
    "group": "note",
    "label": "金额",
    "requirement": "与个人担保上的担保金额一致",
    "notice": "若不一致，提示列在保证书的审查结果之下即可"
  },
  {
    "row": 20,
    "group": "note",
    "label": "发票日",
    "requirement": "与个人担保上的签署日期一致",
    "notice": "若不一致，需提示：本票发票日与担保签署日期不一致，请修正。"
  },
  {
    "row": 21,
    "group": "note",
    "label": "给付日",
    "requirement": "留空",
    "notice": "若未留空，提示：未留空，人工判断"
  },
  {
    "row": 22,
    "group": "note",
    "label": "给付金额",
    "requirement": "留空",
    "notice": "若未留空，提示：未留空，人工判断"
  },
  {
    "row": 23,
    "group": "note",
    "label": "银行名称",
    "requirement": "与个人担保上的银行名称一致",
    "notice": "若不一致，提示列在保证书的审查结果之下即可"
  },
  {
    "row": 24,
    "group": "note",
    "label": "发票人签署",
    "requirement": "需与个人担保上的担保人一致",
    "notice": "若不一致，提示列在保证书的审查结果之下即可"
  },
  {
    "row": 25,
    "group": "note",
    "label": "地址",
    "requirement": "需与保证人与身份证明文件上担保人地址一致，或由客户经理确认",
    "notice": "若不一致，提示怎样不一致，并提示需更正或由客户经理合理澄清。"
  },
  {
    "row": 26,
    "group": "note",
    "label": "以X法律为准据法",
    "requirement": "文件适用法律应与保证书的适用法律一致",
    "notice": "若不一致，提示列在保证书的审查结果之下即可"
  },
  {
    "row": 29,
    "group": "authorization",
    "label": "银行",
    "requirement": "与个人担保上的银行名称一致",
    "notice": "若不一致，提示列在保证书的审查结果之下即可"
  },
  {
    "row": 30,
    "group": "authorization",
    "label": "日期",
    "requirement": "通常与本票日期一致，不应晚于本票日期",
    "notice": "若不符合要求，提示：授权书日期晚于本票日期，请修正。"
  },
  {
    "row": 31,
    "group": "authorization",
    "label": "立书人",
    "requirement": "与个人担保上及身份证明文件上的担保人名称一致",
    "notice": "若不一致，\n-与个人担保上的不一致，列在个人担保下即可\n- 与身份证明文件上不一致，列在授权书下，提示怎样不一致，并提示人工判断。"
  },
  {
    "row": 32,
    "group": "authorization",
    "label": "依X法律解释",
    "requirement": "文件适用法律应与保证书的适用法律一致",
    "notice": "若不一致，提示列在保证书的审查结果之下即可"
  },
  {
    "row": 33,
    "group": "authorization",
    "label": "立书人签署",
    "requirement": "由担保人签署",
    "notice": "提示用户审查，并需加入此点作为审查结果：客户经理需确认已核对签字"
  },
  {
    "row": 34,
    "group": "authorization",
    "label": "姓名",
    "requirement": "与个人担保上及身份证明文件上的担保人名称一致",
    "notice": "若不一致，提示怎样不一致，人工判断"
  },
  {
    "row": 35,
    "group": "authorization",
    "label": "职衔",
    "requirement": "不为空",
    "notice": "若留空，提示：留空，请补充"
  },
  {
    "row": 36,
    "group": "authorization",
    "label": "身份证字号",
    "requirement": "与身份证明文件上的担保人名称一致",
    "notice": "若无，提示无保证人身份证号码，需要补充；若缺失某个保证人身份证号码，则提示哪个保证人身份证号码需要补充"
  },
  {
    "row": 37,
    "group": "authorization",
    "label": "住址",
    "requirement": "需与证明文件上担保人地址一致，或由客户经理确认",
    "notice": "若不一致，提示怎样不一致，并提示需更正或由客户经理合理澄清。"
  },
  {
    "row": 38,
    "group": "authorization",
    "label": "背书人",
    "requirement": "留空",
    "notice": "若未留空，提示：未留空，人工判断"
  },
  {
    "row": 40,
    "group": "legal",
    "label": "法律意见书",
    "requirement": "检查是否合资格司法管辖区的境外担保，如适用，则可根据跨境担保简化流程应取得环球客户经理证明；如不适用，则应取得银行指定律师事务所出具的法律意见书，以确保保证的有效性和可执行性，否则须得到风险管理部的法律意见豁免批准。",
    "notice": "若无提供法律意见书，需请客户经理获取风控的批复\n\n若有提供按F列审查并提示不符合该等要求的内容、参考原因及建议"
  },
  {
    "row": 41,
    "group": "legal",
    "label": "律所资格及范围",
    "requirement": "检查是否我行批准的律所；且该律所所负责的范畴是否包含本担保审查的内容",
    "notice": "逐一列出不一致"
  },
  {
    "row": 42,
    "group": "legal",
    "label": "法律意见引用信息",
    "requirement": "检查 法律意见书提及的信息是否与所提交的文件内容相匹配，包括客户名称，担保人名称，银行名称，律师提及已经审查的文件内容，适用法律等",
    "notice": "若遇非匹配的情况，逐一列出\n- 法律意见书有但无提供的文件\n- 法律意见书有提及的文件有提供，但日期或其他内容不匹配\n- 若遇疑似异常，提示所发现的差异并需人工判断"
  },
  {
    "row": 43,
    "group": "legal",
    "label": "不利内容与后续事项",
    "requirement": "除以上外任何有可能损害或不利于银行的内容；需要先完成文件才有效的内容；需要后续跟进的内容 等",
    "notice": "请高亮并提示用户注意此等信息"
  },
  {
    "row": 47,
    "group": "identity",
    "label": "国别",
    "requirement": "1. 借款人为境外公司，若担保个人为境外个人，则该个人可以为境外公司提供担保。\n2. 借款人为境外公司，若担保个人为境内个人，该担保无效。\n3. 担保人国别与各担保文件适用法律是否一致",
    "notice": "若遇2， 高亮提示担保无效，放在审查结果第一点。\n\n若担保人国别与担保文件适用法律不一致， 提示担保人属何种国别，担保文件适用法律是什么，需用户进一步判断是否合适,配套法律意见或同等文件是否到位。"
  },
  {
    "row": 48,
    "group": "identity",
    "label": "其他信息",
    "requirement": "与担保文件一致；注意有可能有多个担保人的情况",
    "notice": "若有不一致，提示列在对应的文件的审查结果之下"
  }
] as const;
export const PERSONAL_CHECKLIST_ROWS = [
  {
    "row": 3,
    "text": "1.  Obligor is duly incorporated and validly existing under local laws",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "row": 4,
    "text": "2. Searches – no appointment of liquidator or receiver ",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "row": 5,
    "text": "3.  Obligor has the corporate power to execute the documents and perform its obligations",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "row": 6,
    "text": "4.  Obligor has the necessary corporate authorisation to execute the documents and perform its obligations under them",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "row": 7,
    "text": "5.  Documents have been duly executed by the obligor",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "row": 8,
    "text": "6.  Execution of the documents and performance of obligations \n(i) will not breach the laws of the obligor’s  incorporation location",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "row": 9,
    "text": "(ii) does / will not contravene obligor’s constitutional documents",
    "matrix": [
      "",
      "",
      "X"
    ]
  },
  {
    "row": 10,
    "text": "7.  Obligor’s obligations are legal, valid, binding and enforceable",
    "matrix": [
      "",
      "X",
      ""
    ]
  },
  {
    "row": 11,
    "text": "8.  No authorisations or consents etc are required to enable the obligor to execute the documents and perform its obligations",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "row": 12,
    "text": "9.  No stamp duty or registration taxes are payable in respect of any document (except as specifically listed)",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "row": 13,
    "text": "10.  No filings or registrations are required to ensure the enforceability of the financing documents s/enable the obligor to execute the documents or perform its obligations (except as specifically listed) ",
    "matrix": [
      "",
      "",
      ""
    ]
  },
  {
    "row": 14,
    "text": "11.  The security documents create valid security interests(subject to the security perfection requirement as specifically listed)",
    "matrix": [
      "",
      "X",
      ""
    ]
  },
  {
    "row": 15,
    "text": "12.  The documents contain a valid and binding choice of \n(i) governing law \n(ii) jurisdiction",
    "matrix": [
      "X",
      "",
      "X"
    ]
  },
  {
    "row": 16,
    "text": "13. Recognition and Enforcement of foreign judgment in local jurisdiction",
    "matrix": [
      "X",
      "",
      "X"
    ]
  },
  {
    "row": 17,
    "text": "14. No Finance Party is deemed to be domiciled or carrying on business",
    "matrix": [
      "Required if possible",
      "Required if possible",
      "Required if possible"
    ]
  },
  {
    "row": 18,
    "text": "15. No Finance Party is required to be licensed, qualified or entitled to carry on business",
    "matrix": [
      "Required if possible",
      "Required if possible",
      "Required if possible"
    ]
  },
  {
    "row": 19,
    "text": "16. No immunity from suit, execution, attachment or other legal process",
    "matrix": [
      "Required if possible",
      "Required if possible",
      "X"
    ]
  }
] as const;

/** Checklist introductory requirements, before the opinion-type matrix. */
export const PERSONAL_CHECKLIST_INTRO = [
 {paragraph:4,label:"收件人",text:"Include HSBC Bank (China) Company Limited and/or the relevant HBCN branch."},
 {paragraph:6,label:"披露限制",text:"Check permitted disclosure to affiliates and advisers, potential transferees/sub-participants/assignees, for proceedings or disputes, and as required by law, courts, exchanges or authorities."},
 {paragraph:12,label:"审阅文件清单",text:"Ensure all relevant documents are listed among the documents opined upon."},
 {paragraph:14,label:"假设",text:"Assumptions should be factual matters outside the law firm’s knowledge and control; must not assume all obligor representations are correct or assume matters within the lawyer’s work scope."},
 {paragraph:16,label:"保留意见",text:"Qualifications should be based on applicable law or judicial practice and must not undermine the opinions."},
 {paragraph:18,label:"责任限制",text:"The legal opinion should not contain a limitation of liability."},
] as const;
