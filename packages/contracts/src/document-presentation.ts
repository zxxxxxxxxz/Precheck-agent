import type {DocumentFieldObservation} from './documents.js';
import type {EvidenceAnchor} from './evidence.js';
import {scopeCorporateArticlesQuorum} from './corporate-articles.js';
import type {AutomaticSignatureRecord} from './signature-information.js';

type Candidate = DocumentFieldObservation['candidates'][number];

/** Read-only presentation DTO; never accepted as an immutable model candidate or adoption command. */
export type FieldCandidatePresentation = Candidate & {presentationSourceMode?: 'repeated_single_value'};
/** A source row is a reading aid, never an adoptable candidate or identity decision. */
export interface FieldTableRecord {
  id: string;
  kind: 'meeting' | 'signatory';
  logicalDocumentId: string;
  regionId: string;
  rowIndex: number;
  pageNumber: number;
  sourceTextSha256: string;
  anchorIds: string[];
  candidateIndexes: number[];
  components: {
    role: 'date' | 'time' | 'place' | 'name_capacity' | 'identity_record' | 'specimen';
    value: string;
    rawValue: string;
    anchorIds: string[];
    locationAnchorIds: string[];
    localization: 'text' | 'table';
  }[];
}
export type DocumentFieldPresentation = Omit<DocumentFieldObservation, 'candidates'> & {
  candidates: FieldCandidatePresentation[];
  /** Literal historical source reading aid; not an adoptable candidate. */
  guaranteeSourceValue?: {displayValue:string;anchorIds:string[];pageNumbers:number[]};
  tableRecords?: {version: 'source-table-records-v1'; records: FieldTableRecord[]; otherCandidateIndexes: number[]};
  /** Shared source observations; never an adopted fact or signing-validity decision. */
  signatureRecords?: {purpose:'execution'|'specimen';state:'detected'|'not_detected'|'unavailable';coverageIncomplete?:boolean;records:AutomaticSignatureRecord[]};
};

export const tableRecordLabels: Record<FieldTableRecord['components'][number]['role'], string> = {
  date: '日期', time: '时间', place: '地点', name_capacity: '姓名及职务', identity_record: '身份记录', specimen: '签字样本栏原文',
};
export function tableRecordDisplayText(record: FieldTableRecord): string {
  return record.components.map(component => `${tableRecordLabels[component.role]}：${component.value || '未识别到文字'}`).join('\n');
}


/** Presentation only: original source text and evidence are never rewritten. */
export function fieldDisplayText(value: string): string {
  return value.replace(/<\/?(?:table|thead|tbody|tfoot|tr|td|th|br)(?:\s[^<>]*)?\s*\/?>/giu, ' ').replace(/[\t\r\n ]+/gu, ' ').trim();
}

/** Name associations are source-backed candidates, never identity confirmation. */
export function fieldCandidateDisplayText(candidate: Candidate): string {
  const names = [...new Set(candidate.nameAssociation?.names.map(fieldDisplayText).filter(Boolean) ?? [])];
  if (names.length > 1) {
    const chinese = names.filter(name => /\p{Script=Han}/u.test(name));
    const others = names.filter(name => !/\p{Script=Han}/u.test(name));
    if (chinese.length === 1 && others.length === 1) return `${chinese[0]}（${others[0]}）`;
    return [...chinese, ...others].join(' / ');
  }
  return fieldDisplayText(candidate.displayValue ?? candidate.rawValue);
}

/** Collapse a shorter quotation only when its complete source span is covered
 * by a longer quotation in the same occurrence. Never equate separate entities
 * by spelling, page number or a shared table rectangle. Stored candidates stay intact. */
export function distinctSourceCandidates(field: DocumentFieldPresentation, anchors: readonly EvidenceAnchor[], corroborates?: (inner: EvidenceAnchor, outer: EvidenceAnchor) => boolean): DocumentFieldPresentation {
  if (field.humanRevisionId || field.semanticFilter?.state !== 'completed' || field.tableRecords) return field;
  const source = new Map(anchors.filter(a => a.document_version_id === field.documentVersionId && a.parse_revision === field.parseRevision && a.evidence_kind === 'text').map(a => [a.anchor_id, a]));
  const text = (c: Candidate) => fieldDisplayText(c.rawValue).normalize('NFC');
  const spans = (c: Candidate) => c.anchorIds.flatMap(id => {
    const a = source.get(id);
    return a ? a.text_span_refs.map(s => ({...s, page: a.page_number, asset: a.page_asset_id, anchor: a})) : [];
  });
  const exactQuote = (c: Candidate) => c.anchorIds.length > 0 && c.anchorIds.every(id => {
    const a = source.get(id);
    return a && a.text_span_refs.reduce((sum, s) => sum + s.length, 0) === [...c.rawValue].length;
  });
  const candidates = field.candidates.filter((candidate, index, all) => {
    const value = text(candidate), own = spans(candidate);
    if (!value || !own.length || candidate.structuredValue) return true;
    // Composite candidates can repeat one identical clause after a second model
    // pass. Same text still needs the same located source; another page or an
    // independent occurrence remains a separate candidate.
    if (all.some((other, otherIndex) => otherIndex < index && text(other) === value && own.every(s => spans(other).some(t =>
      s.page === t.page && s.asset === t.asset && (s.block_id === t.block_id && s.offset >= t.offset && s.offset + s.length <= t.offset + t.length || corroborates?.(s.anchor, t.anchor)))))) return false;
    if (!exactQuote(candidate) || (candidate.evidenceSegments?.length ?? 0) > 1) return true;
    return !all.some((other, otherIndex) => {
      const longer = text(other);
      if (index === otherIndex || longer.length < value.length || longer.length === value.length && otherIndex > index || !longer.includes(value)) return false;
      if ((other.evidenceSegments?.length ?? 0) > 1 || other.structuredValue || !exactQuote(other)) return false;
      if (field.valueMultiplicity === 'entities') {
        // Containment cannot establish bilingual correspondence or combine
        // several named parties. That remains the name-association workflow.
        if (!longer.startsWith(value) || /\p{Script=Han}/u.test(value)!==/\p{Script=Han}/u.test(longer) || /[A-Za-z]/u.test(value)!==/[A-Za-z]/u.test(longer) ||
          /(?:\b(?:and|or)\b|[,;；、/＆&])/iu.test(longer.slice(value.length))) return false;
      }
      if (candidate.nameAssociation?.names.some(name => !longer.includes(fieldDisplayText(name)))) return false;
      const outer = spans(other);
      return own.every(s => outer.some(t => s.page === t.page && s.asset === t.asset &&
        (s.block_id === t.block_id && s.offset >= t.offset && s.offset + s.length <= t.offset + t.length || corroborates?.(s.anchor, t.anchor))));
    });
  });
  if (candidates.length === field.candidates.length) return field;
  return {...field, candidates, rawValue: candidates.length === 1 ? candidates[0]!.rawValue : field.rawValue,
    normalizedValue: candidates.length === 1 ? candidates[0]!.normalizedValue : field.normalizedValue,
    anchorIds: [...new Set(candidates.flatMap(c=>c.anchorIds))], pageNumbers: [...new Set(candidates.flatMap(c=>c.pageNumbers))]};
}

/** Group identical values or explicitly registered aliases; keep all source locations. */
export function presentationFieldCandidates(candidates: readonly FieldCandidatePresentation[], valueMultiplicity?: DocumentFieldObservation['valueMultiplicity']): FieldCandidatePresentation[] {
  const groups = new Map<string | symbol, FieldCandidatePresentation>();
  for (const candidate of candidates) {
    // Missing text is not evidence that independent candidates agree.
    // A common opening does not make different cross-page conditions equal.
    // Keep separate occurrences separate too: concatenating their source
    // segments would manufacture a repeated multi-page clause.
    const valueKey = candidate.presentationSourceMode !== 'repeated_single_value' && candidate.evidenceSegments && candidate.evidenceSegments.length > 1
      ? `segments:${JSON.stringify(candidate.evidenceSegments)}`
      : candidate.rawValue.trim() || Symbol();
    // Names require explicit correspondence. Equal spelling or a model entity
    // key alone cannot join independent people, roles or logical documents.
    const key = candidate.nameAssociation ? `name:${candidate.nameAssociation.groupId}`
      : valueMultiplicity === 'entities' ? Symbol() : candidate.entityKey ? `entity:${candidate.entityKey}` : valueKey;
    const existing = groups.get(key);
    if (existing) {
      const repeatedSingle = existing.rawValue.trim() === candidate.rawValue.trim()
        && Boolean(existing.evidenceSegments?.length || candidate.evidenceSegments?.length)
        && (existing.presentationSourceMode === 'repeated_single_value' || (existing.evidenceSegments?.length ?? 0) <= 1)
        && (candidate.presentationSourceMode === 'repeated_single_value' || (candidate.evidenceSegments?.length ?? 0) <= 1);
      if (repeatedSingle) existing.presentationSourceMode = 'repeated_single_value';
      else delete existing.presentationSourceMode;
      existing.anchorIds = [...new Set([...existing.anchorIds, ...candidate.anchorIds])];
      existing.pageNumbers = [...new Set([...existing.pageNumbers, ...candidate.pageNumbers])];
      if(existing.contextAnchorIds||candidate.contextAnchorIds)existing.contextAnchorIds=[...new Set([...(existing.contextAnchorIds??[]),...(candidate.contextAnchorIds??[])])];
      if((existing.entityKey || existing.nameAssociation)&&existing.rawValue.trim()!==candidate.rawValue.trim())existing.normalizedValue=null;
      if (existing.evidenceSegments || candidate.evidenceSegments) existing.evidenceSegments = [...new Map([...(existing.evidenceSegments ?? []), ...(candidate.evidenceSegments ?? [])].map(segment => [JSON.stringify(segment), segment])).values()];
      if (existing.structuredValue && candidate.structuredValue?.kind === existing.structuredValue.kind) existing.structuredValue = {...existing.structuredValue, components: [...new Map([...existing.structuredValue.components, ...candidate.structuredValue.components].map(component => [JSON.stringify(component), component])).values()]};
      if (existing.nameAssociation && candidate.nameAssociation) {
        const sourceNames = new Map<string, {name: string; anchorIds: string[]; pageNumbers: number[]}>();
        for (const source of [...(existing.nameAssociation.sourceNames ?? []), ...(candidate.nameAssociation.sourceNames ?? [])]) {
          const previous = sourceNames.get(source.name);
          sourceNames.set(source.name, {name: source.name,
            anchorIds: [...new Set([...(previous?.anchorIds ?? []), ...source.anchorIds])],
            pageNumbers: [...new Set([...(previous?.pageNumbers ?? []), ...source.pageNumbers])],
          });
        }
        existing.nameAssociation = {...existing.nameAssociation, names: [...new Set([...existing.nameAssociation.names, ...candidate.nameAssociation.names])],
          evidenceAnchorIds: [...new Set([...existing.nameAssociation.evidenceAnchorIds, ...candidate.nameAssociation.evidenceAnchorIds])],
          ...(existing.nameAssociation.sourceNames || candidate.nameAssociation.sourceNames ? {sourceNames: [...sourceNames.values()]} : {}),
        };
      }
    } else groups.set(key, {...candidate, anchorIds: [...new Set(candidate.anchorIds)], pageNumbers: [...new Set(candidate.pageNumbers)]});
  }
  return [...groups.values()];
}

/** Keep source candidates untouched; API clients may opt into this read-only view. */
export function presentDocumentFields(items: readonly DocumentFieldObservation[]): DocumentFieldPresentation[] {
  return items.map(scopeCorporateArticlesQuorum).map(field => {
    const candidates = presentationFieldCandidates(field.candidates, field.valueMultiplicity);
    const sameValue = field.candidates.length > 1 && candidates.length === 1 && Boolean(candidates[0].rawValue.trim());
    return {...field, candidates,
      rawValue: sameValue ? candidates[0].rawValue : field.rawValue,
      normalizedValue: sameValue ? candidates[0].normalizedValue : field.normalizedValue,
      coverageGaps: field.coverageGaps.filter(gap => !sameValue || gap !== 'multiple_field_candidates'),
      anchorIds: [...new Set([...field.anchorIds, ...candidates.flatMap(candidate => candidate.anchorIds)])],
    };
  });
}

export interface FieldEvidencePresentation {
  rawValue: string;
  anchorIds: string[];
  pageNumbers: number[];
  contexts: {text: string; anchorIds: string[]; pageNumbers: number[]}[];
}

/** Repeated single values share one displayed value, while each context keeps its own sources. */
export function fieldCandidateEvidenceGroups(candidate: FieldCandidatePresentation): FieldEvidencePresentation[] {
  const segments = candidate.evidenceSegments ?? [];
  const groups = new Map<string | symbol, FieldEvidencePresentation>();
  for (const segment of segments) {
    const key = candidate.presentationSourceMode === 'repeated_single_value' ? segment.rawValue.trim() : Symbol();
    const current = groups.get(key) ?? {rawValue: segment.rawValue, anchorIds: [], pageNumbers: [], contexts: []};
    current.anchorIds = [...new Set([...current.anchorIds, ...segment.anchorIds])];
    current.pageNumbers = [...new Set([...current.pageNumbers, ...segment.pageNumbers])];
    if (segment.contextText) {
      const ids = segment.contextAnchorIds?.length ? segment.contextAnchorIds : segment.anchorIds;
      const context = current.contexts.find(value => value.text === segment.contextText);
      if (context) {
        context.anchorIds = [...new Set([...context.anchorIds, ...ids])];
        context.pageNumbers = [...new Set([...context.pageNumbers, ...segment.pageNumbers])];
      } else current.contexts.push({text: segment.contextText, anchorIds: [...ids], pageNumbers: [...segment.pageNumbers]});
    }
    groups.set(key, current);
  }
  return [...groups.values()];
}

export function fieldCandidateCompleteDisplayText(candidate: FieldCandidatePresentation): string {
  const segments = fieldCandidateEvidenceGroups(candidate);
  return segments.length ? segments.map(segment => fieldDisplayText(segment.rawValue)).join('\n') : fieldDisplayText(candidate.rawValue);
}

/** Human corrections and actual field values always take precedence. */
export function guaranteeSourceValue(field:DocumentFieldPresentation) {
  return field.status!=='not_applicable' && !field.humanRevisionId && !field.rawValue?.trim() && !field.candidates.length ? field.guaranteeSourceValue : undefined;
}
