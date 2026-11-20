/** Words that name a role, a form box or a kind of document, and words that only join others. A passage made of nothing
 * else names no one, so redaction leaves it as written: the reader needs these labels to find the values next to them.
 *
 * Program-owned and fixed. Place names, legal-entity suffixes (Limited, 有限公司, Holdings, Trading, Group…) and anything
 * that occurs inside real names on its own are deliberately absent, so a name built from them is never released. */
const englishTerms = new Set([
  // parties and roles
  'bank', 'banks', 'banking', 'lender', 'lenders', 'lending', 'borrower', 'borrowers', 'customer', 'customers', 'client',
  'guarantor', 'guarantors', 'guarantee', 'guarantees', 'guaranteed', 'principal', 'obligor', 'debtor', 'creditor',
  'director', 'directors', 'alternate', 'secretary', 'secretaries', 'chairman', 'chairperson', 'shareholder', 'shareholders',
  'member', 'members', 'officer', 'officers', 'auditor', 'auditors', 'regulator', 'regulators', 'counsel', 'lawyer', 'lawyers',
  'solicitor', 'solicitors', 'witness', 'witnesses', 'witnessed', 'signatory', 'signatories', 'authorised', 'authorized',
  'representative', 'representatives', 'agent', 'process', 'executor', 'executors', 'administrator', 'administrators',
  'successor', 'successors', 'assign', 'assigns', 'individual', 'individuals', 'person', 'persons', 'party', 'parties',
  'company', 'companies', 'body', 'corporate', 'private', 'public', 'listed', 'entity', 'entities', 'sir', 'sirs', 'madam',
  'rm', 'grm', 'relationship', 'manager', 'managers', 'former', 'new', 'existing', 'parent', 'subsidiary',
  // form boxes
  'name', 'names', 'named', 'full', 'english', 'chinese', 'surname', 'given', 'alias', 'address', 'addresses', 'registered',
  'office', 'offices', 'branch', 'place', 'region', 'country', 'state', 'province', 'city', 'street', 'estate', 'lot',
  'village', 'postal', 'code', 'number', 'numbers', 'no', 'nos', 'reference', 'ref', 'identification', 'identity', 'id',
  'document', 'documents', 'type', 'card', 'passport', 'certificate', 'registration', 'registry', 'register', 'date',
  'dated', 'signature', 'signed', 'seal', 'stamp', 'chop', 'form', 'capacity', 'position', 'title', 'meeting', 'resolution',
  'resolutions', 'board', 'minutes', 'notice', 'account', 'balance', 'amount', 'currency', 'facility', 'facilities',
  'letter', 'offer', 'term', 'terms', 'condition', 'conditions', 'clause', 'clauses', 'schedule', 'jurisdiction',
  'jurisdictions', 'home', 'court', 'courts', 'tribunal', 'arbitration', 'law', 'laws', 'governing', 'confirmation',
  'waiver', 'renewal', 'bankruptcy', 'insolvency', 'liquidation', 'legal', 'opinion', 'certification', 'overseas',
  'block', 'letters', 'email', 'telephone', 'phone', 'fax', 'contact', 'local',
  // words that only join others
  'the', 'of', 'to', 'by', 'for', 'in', 'on', 'at', 'as', 'and', 'or', 'nor', 'with', 'without', 'between',
  'from', 'under', 'this', 'that', 'these', 'those', 'its', 'their', 'his', 'her', 'was', 'were', 'is', 'are', 'be', 'been',
  'being', 'would', 'should', 'shall', 'which', 'where', 'whereby', 'whereas', 'who', 'whom', 'whose', 'such', 'any', 'all',
  'each', 'other', 'said', 'hereby', 'herein', 'hereof', 'thereof', 'therein', 'forthwith', 'wholly', 'owned', 'duly',
  'empowered', 'reviewed', 'pursuant', 'subject', 'nil', 'if', 'applicable',
]);
/** Chinese terms of two characters or more; a run of Chinese text is generic when it is one of them or is made of them. */
const chineseTerms = new Set([
  '担保', '擔保', '保证', '保證', '银行', '銀行', '贷款银行', '貸款銀行', '授信函', '授信', '额度', '額度', '授信额度', '授信額度', '借款人', '借款方', '贷款人', '貸款人',
  '担保人', '擔保人', '保证人', '保證人', '担保公司', '擔保公司', '被担保公司', '被擔保公司', '公司担保', '公司擔保', '公司保证', '公司保證',
  '保证书', '保證書', '担保书', '擔保書', '公司保证书', '公司保證書', '债务人', '債務人', '客户', '客戶', '见证人', '見證人', '签字人', '簽字人',
  '签署', '簽署', '董事', '董事会', '董事會', '股东', '股東', '股东会', '股東會', '决议', '決議', '秘书', '秘書', '公司秘书', '公司秘書',
  '主席', '律师', '律師', '律所', '法院', '仲裁机构', '仲裁機構', '管辖', '管轄', '地点', '地點', '地址', '住所', '位置', '姓名', '名称',
  '名稱', '中文', '英文', '中英文', '公司', '本公司', '母公司', '子公司', '母子公司', '私人公司', '公众公司', '公眾公司', '上市公司',
  '编号', '編號', '号码', '號碼', '身份', '身分', '身份证', '身份證', '证件', '證件', '证明', '證明', '证明书', '證明書', '文件', '种类',
  '種類', '注册', '註冊', '注册地', '註冊地', '注册处', '註冊處', '办事处', '辦事處', '商业登记', '商業登記', '登记', '登記', '日期',
  '签名', '簽名', '印章', '盖章', '蓋章', '职位', '職位', '国家', '國家', '地区', '地區', '期限', '金额', '金額', '币种', '幣種',
  '客户经理', '客戶經理', '环球客户经理', '環球客戶經理', '会议', '會議', '时间', '時間', '服务提供者', '服務提供者', '委任', '停任', '前用',
  '章程', '修正案', '选项', '選項', '别名', '別名', '私人', '公众', '公眾', '被授权人', '被授權人', '授权人', '授權人', '办事', '辦事', '代理人', '受托人', '受託人', '投保人',
]);
/** Whole phrases that are a form box although one of their words is a legal-entity suffix. */
const phrases = new Set(['company limited by guarantee', 'limited company', 'private company limited by shares', 'public company limited by shares']);
/** Single characters that are a whole form box in address and name tables; never part of a composed run. */
const chineseBoxes = new Set(['市', '州', '村', '座', '室', '楼', '樓', '层', '層', '区', '區', '街', '号', '號', '名', '姓']);
const chineseConnectors = ['中的', '的', '之', '及', '与', '與', '和', '或', '中'];
const MAX_TERM = Math.max(...[...chineseTerms].map(term => term.length));
const han = /\p{Script=Han}/u;

function chineseRunIsGeneric(run: string, whole: boolean): boolean {
  if (chineseTerms.has(run) || whole && chineseBoxes.has(run)) return true;
  // reach[i]: the first i characters split into terms; a connector may only stand between two terms.
  const reach = new Array<boolean>(run.length + 1).fill(false);
  reach[0] = true;
  for (let at = 0; at < run.length; at++) {
    if (!reach[at]) continue;
    for (let length = 2; length <= Math.min(MAX_TERM, run.length - at); length++) {
      if (!chineseTerms.has(run.slice(at, at + length))) continue;
      const end = at + length;
      reach[end] = true;
      for (const connector of chineseConnectors) {
        if (!run.startsWith(connector, end)) continue;
        // Only keep the connector when another term follows it.
        for (let next = 2; next <= Math.min(MAX_TERM, run.length - end - connector.length); next++) {
          if (chineseTerms.has(run.slice(end + connector.length, end + connector.length + next))) reach[end + connector.length] = true;
        }
      }
    }
  }
  return reach[run.length]!;
}

/** Whether a passage is made only of role words, form boxes and joining words. Digits, e-mail, single letters (initials,
 * block or unit letters) and anything outside the fixed lists make it specific. An already masked span (U+FFFC) carries
 * no source bytes and is skipped. */
export function genericDocumentTerm(raw: string): boolean {
  const text = raw.normalize('NFKC').trim().replace(/['’]s\b/gu, '');
  if (!text || text.length > 160 || /[\d@]/u.test(text)) return false;
  if (phrases.has(text.toLowerCase().replace(/\s+/gu, ' '))) return true;
  const tokens = text.split(/[\s￼.,:;!?()[\]{}<>/\\|_“”"'‘’`~^*#=+&\-–—、，。：；（）【】／《》「」『』·…]+/u).filter(Boolean);
  if (!tokens.length) return false;
  const runs = tokens.flatMap(token => token.split(/(?<=\p{Script=Han})(?=[^\p{Script=Han}])|(?<=[^\p{Script=Han}])(?=\p{Script=Han})/u));
  return runs.every(run => han.test(run)
    ? /^\p{Script=Han}+$/u.test(run) && chineseRunIsGeneric(run, runs.length === 1)
    : run.length > 1 && englishTerms.has(run.toLowerCase()));
}

/** The whole word or words around a recognised span: a recogniser can mark one letter of "with" or one character of
 * "公司". Letters on either side are taken in, across scripts ("银行Bank"), up to a space, punctuation, digit or mask. */
export function surroundingWords(text: string, start: number, end: number): string {
  const letter = /[\p{L}\p{M}]/u;
  while (start > 0 && letter.test(text[start - 1]!)) start--;
  while (end < text.length && letter.test(text[end]!)) end++;
  return text.slice(start, end);
}

/** A label and its value read as one span: "NAME OF RM<tab>Ivan Leung", "Name of Guarantor: X Limited". When the leading
 * or trailing part is generic and set off by a layout gap (a tab, two or more spaces, a colon or a line break), returns
 * the offsets of the rest, which stays masked. Words inside a name are never split off: a single space is not a gap. */
export function genericLabelTrim(text: string): { start: number; end: number } | null {
  const gap = /(?:\t|[ 　]{2,}|\s*[:：]\s*|\s*\n\s*)+/gu;
  const gaps = [...text.matchAll(gap)].filter(match => match.index! > 0 && match.index! + match[0].length < text.length);
  if (!gaps.length) return null;
  let start = 0, end = text.length;
  const first = gaps[0]!;
  if (genericDocumentTerm(text.slice(0, first.index!))) start = first.index! + first[0].length;
  const last = gaps.at(-1)!;
  if (last.index! >= start && genericDocumentTerm(text.slice(last.index! + last[0].length))) end = last.index!;
  if (start === 0 && end === text.length || start >= end) return null;
  const core = text.slice(start, end);
  // A rest that opens or closes on a joining word continues a name ("Bank  of China"); nothing is split off then.
  if (/^(?:of|and|the|&|de|du|des|di|da|von|van|y)\b/iu.test(core.trim()) || /\b(?:of|and|&)$/iu.test(core.trim())) return null;
  return core.trim() && !genericDocumentTerm(core) ? { start, end } : null;
}
