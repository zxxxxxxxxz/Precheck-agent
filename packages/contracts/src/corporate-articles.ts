import type {DocumentFieldObservation} from './documents.js';
import type {ReviewFieldDefinition} from './review-config.js';

export const CORPORATE_ARTICLES_REVIEW_INPUTS = ['cgt_resolution_minimum', 'cgt_charter_minimum'] as const;

export const corporateArticlesDefinitions: Record<string, Partial<ReviewFieldDefinition>> = {
  cgt_field_64: {
    label: '董事会议最少出席人数',
    aliases: ['董事会议最少出席人数', '法定人数', '法定人數', 'Quorum', "Quorum for directors’ meetings"],
    semanticDefinition: '仅提取规定董事会议最少出席人数（quorum）的原文条款，以及直接影响人数计算的表决资格、利益冲突排除、全程维持法定人数及适用例外。保留人数、条件、例外和条款号，不把最低出席人数等同于决议签署人数。排除一般会议通知、召集程序、主席选任、普通表决多数、书面决议及会议记录保存条款；仅提到记录 quorum 不构成人数要求。不从实际出席名单推算门槛，不因未见条款推断为一人。',
  },
  cgt_field_65: {
    label: '提供担保的限制或许可',
    aliases: ['提供担保的限制或许可', 'Guarantee', 'Guarantees', '担保', '擔保'],
    semanticDefinition: '检索本文件全文，逐条提取明确允许、限制或禁止公司提供担保的原文，包括适用对象、金额或业务范围、前提、例外以及相关修正和生效日期。保留完整条件及原文位置；不把普通借款权、投资权或一般经营权自动当作担保许可。所需董事会／股东会决议另由独立字段提取；同一条款同时规定许可及决议条件时，两字段均保留相关依据。检索覆盖不足或没有明确条款时保持未知，不推断为允许担保。多份章程和修正案须按所修改条款及日期人工核对，不在单文件提取时宣称已确定最终有效版本。',
  },
  cgt_articles_required_resolution: {
    label: '提供担保所需决议',
    aliases: ['提供担保所需决议', 'Board resolution', 'Shareholder resolution', 'Members resolution', '董事会决议', '股东会决议'],
    semanticDefinition: '检索本文件全文，提取明确规定提供担保须由董事会、股东会或两者批准的原文条款，完整保留适用情形、前置条件、例外、决议类型、相关修正及生效日期。只凭一般董事管理权或多数表决规则不能推断担保审批机关；不得借用实际决议文件填入章程要求。董事会与股东会分别适用于不同情形时必须保留条件，不概括成任意选择。没有明确依据、冲突或全文覆盖不足时保持待核对；多份章程／修正案的有效性须按条款与日期人工核对。',
  },
};

/** Reject clearly unrelated meeting administration, including incidental quorum
 * mentions in minutes. Unknown wording is retained for review, never silently
 * interpreted as a different numeric requirement. */
export function unrelatedBoardMeetingClause(text: string): boolean {
  const value = text.replace(/\s+/gu, ' ');
  const operative = /quorum\s+(?:(?:shall|must|should|may|cannot|can\s+not)\b|is\b|be\b|consists?\b|requires?\b|maintained\b|of\s+(?:\d+|one|two|three|four|five)\b)|(?:count(?:ed)?|reckon(?:ed)?)\s+(?:in|towards?|for)\s+(?:(?:the|its)\s+)?quorum|(?:法定人[数數]|最低出席人[数數]|最少出席人[数數]).{0,30}(?:[一二三四五六七八九十两兩\d]|维持|維持|保持)|(?:不得|不应|不應|不予).{0,12}(?:计入|計入).{0,12}法定人[数數]/iu.test(value);
  if (operative) return false;
  return /(?:^|\d[.)]\s*)notices?\s*[.:]|notice of (?:directors['’]? )?meetings|(?:minutes|records).{0,50}(?:record|keep|retain)|written (?:directors['’]? decisions|resolution)|(?:会议|會議)(?:通知|记录|記錄)|(?:书面|書面)(?:决议|決議)|(?:选举|選舉).{0,10}(?:主席)|(?:simple|ordinary) majority/iu.test(value);
}

/** Automatic candidates only. Original receipts, manual decisions and all
 * evidence anchors remain intact; this also works for old pinned configs. */
export function scopeCorporateArticlesQuorum<T extends DocumentFieldObservation>(field: T): T {
  if (field.fieldId !== 'cgt_field_64') return field;
  const labelled = {...field, fieldLabel: '董事会议最少出席人数'};
  if (field.humanRevisionId) return labelled;
  const candidates = field.candidates.filter(candidate => !unrelatedBoardMeetingClause(candidate.rawValue));
  if (candidates.length === field.candidates.length) return labelled;
  const rejected = new Set(field.semanticFilter?.originalCandidates.filter(candidate => unrelatedBoardMeetingClause(candidate.rawValue)).map(candidate => candidate.candidateId));
  return {...labelled, candidates,
    rawValue: candidates.length === 1 ? candidates[0]!.rawValue : null,
    normalizedValue: candidates.length === 1 ? candidates[0]!.normalizedValue : null,
    anchorIds: [...new Set(candidates.flatMap(candidate => candidate.anchorIds))],
    pageNumbers: [...new Set(candidates.flatMap(candidate => candidate.pageNumbers))],
    status: 'uncertain',
    coverageGaps: [...new Set([...field.coverageGaps, ...(!candidates.length ? ['field_not_found_in_processed_scope'] : [])])],
    ...(field.semanticFilter ? {semanticFilter: {...field.semanticFilter,
      decisions: field.semanticFilter.decisions.map(decision => decision.decision === 'selected' && rejected.has(decision.candidateId)
        ? {...decision, decision: 'rejected' as const} : decision),
    }} : {}),
  };
}
