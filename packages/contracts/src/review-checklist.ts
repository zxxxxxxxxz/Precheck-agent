import type {PersonalBankContent} from './personal-bank-comparison.js';
import type {FieldVerification} from './field-verification.js';
import type {ReviewEvidence, ReviewFact, ReviewState} from './review.js';
import type {GuidanceRef} from './review-guidance.js';

export const CORPORATE_CUSTOMER_ADDRESS_CHECK='corporate-customer-address';
/** Execution constants are rule baselines, never extracted or confirmed material values. */
export function fixedComparisonValue(fieldId:string):string|undefined {
  return fieldId==='cgt_yes'||fieldId==='pg_yes'?'yes':undefined;
}
export function fixedComparisonSource(fieldId:string,id:string):CrossFileValue|undefined {
  const value=fixedComparisonValue(fieldId);
  return value===undefined?undefined:{id,fieldId,label:'要求',documentId:null,filename:'规则基准',
    values:[value],evidence:[],warnings:[],state:'available'};
}
/** Read compatibility only: discard legacy material attribution without rewriting its record. */
export function comparisonSource(source:CrossFileValue):CrossFileValue {
  return fixedComparisonSource(source.fieldId,source.id)??source;
}
export type ChecklistStatus = 'missing_material' | 'unprocessed' | 'not_found' | 'pending_confirmation' | 'extracted' | 'confirmed' | 'not_applicable' | 'uncertain';
export interface ChecklistCandidate {id:string;value:string|null;documentId:string;evidence:ReviewEvidence[];confidence?:number|null}
/** Read-only evidence comparison. It never creates identities or approves a business rule. */
export interface CrossFileValue {
  extractionWarnings?:string[];
  extractionVersion?:{parseRevision:string;directoryRevision:number};
  candidates?:Array<{id:string;value:string;confidence:number|null}>;
  /** Current immutable source can be inspected independently of extraction completeness. */
  originalEligible?:boolean;
  /** Text-only comparison may proceed after independent source verification. */
  originalComparisonEligible?:boolean;
  originalSegments?:Array<{value:string;parts:Array<{value:string;evidence:ReviewEvidence[]}>}>;
  /** Scoped, independently corroborated quotations; not a replacement for the extraction receipt. */
  verifiedQuotes?:Array<{text:string;page:number;evidence:ReviewEvidence[];sourceHash:string;method:'independent_text'}>;
  /** All extracted scalar values grounded at their own cited location. */
  personalScalarReading?:{values:string[];evidence:ReviewEvidence[];reason:string};
  id:string;fieldId:string;label:string;documentId:string|null;filename:string;
  values:string[];evidence:ReviewEvidence[];warnings:string[];
  /** Resolved single-field extraction used by subsequent checks. Original
   * alternatives remain available for audit, including on legacy snapshots. */
  displaySelection?:{values:string[];reason:'equivalent'|'highest_confidence'|'unresolved';candidateIds:string[];originalValues?:string[]};

  /** Rechecked literal scope only; never clears the original field's coverage or adopts a fact. */
  scopedReadings?:Array<{kind:'amount'|'currency'|'date'|'text';values:string[];evidence:ReviewEvidence[];reason:string}>;
  /** Server-verified name scope; extraction receipts and other business uses stay unchanged. */
  personalWorkbookReading?:{kind:'borrower'|'law'|'legal'|'date';values:string[];evidence:ReviewEvidence[];passages:Array<{text:string;evidence:ReviewEvidence}>;reason:string};
  personalNameReading?:{kind:'bank'|'law';values:string[];evidence:ReviewEvidence[];reason:string};
  resolvedQuality?:{warnings:string[];originalValues:string[];reason:string};
  state:'available'|'missing'|'processing'|'uncertain'|'not_applicable'|'pending_confirmation';
  /** Explicit empty-state wording for a missing counterpart, never a compared value. */
  missingText?:string;
}
export interface CrossFileCheck {
  bankExecution?:{version:'bank-value-checks-v1'};
  valueBasis?:'extracted';
  checklistRule?:{id:string;text:string;sources:string[]};
  /** Exact bank workbook row; absent on historical/general comparisons. */
  bankRule?:{content?:PersonalBankContent;row:number;reference:string;requirement:string;notice:string;primaryFieldId:string;applicability?:string;currentDate?:string;dates?:Array<{sourceId:string;raw:string;gregorian:string}>};
  id:string;label:string;fieldIds:string[];objectId:string|null;
  method:'text'|'equal'|'date_order'|'minimum'|'manual';
  outcome:'consistent'|'different'|'insufficient'|'manual'|'single_source'|'not_applicable';
  reason:string;manualReasons:string[];sources:CrossFileValue[];
  /** Insufficient comparison caused only by source quality, not rule evaluation. */
  sourceQualityBlocked?:boolean;
  /** Language equivalence is separate from legal identity and rule approval. */
  semanticEligible?:boolean;
  /** Confirmed judgement rules that the semantic comparison must consider. Absent when none apply. */
  guidance?:GuidanceRef[];
  semantic?:{jobId:string;state:'pending'|'complete'|'unavailable'|'failed';outcome:'consistent'|'different'|'insufficient'|'manual';reason:string;simulated:boolean;
    canRetry?:boolean;
    citations:Array<{filename:string;quote:string;evidence:ReviewEvidence[]}>;
    /** Refs from `guidance` that the semantic conclusion actually relied on. */
    appliedGuidance?:string[]};
  /** Optional for historical snapshots; literal observations never approve legal applicability. */
  comparisons?:Array<{id:string;label:string;outcome:'consistent'|'different'|'manual'|'insufficient';reason:string;
    values:Array<{sourceId:string;value:string;quotes?:string[];verified?:boolean}>}>;
  reviewItems?:Array<{kind?:'notice';id:string;title:string;action:string;sourceId:string;quote:string;verified:boolean;evidence:ReviewEvidence[]}>;
}
export interface ChecklistRow {
  documentScope?:{included:boolean;documentIds:string[]};
  /** Current system metadata, separate from extracted evidence and human decisions. */
  systemValue?:{kind:'document_upload_date';sources:CrossFileValue[]};
  sourceVerification?:FieldVerification;verification?:FieldVerification;
  id:string;fieldId:string;label:string;definition:string;objectId:string|null;objectLabel:string;
  objectRole:string|null;guaranteeTypes:string[];status:ChecklistStatus;reason:string;
  materialTypes:Array<{id:string;label:string}>;candidates:ChecklistCandidate[];fact:ReviewFact|null;
  /** File-level previews only; never attributed to an object or adopted as facts. */
  unassignedCandidates?:ChecklistCandidate[];
  confirmations:NonNullable<ReviewState['factRecords']>;
  rules:Array<{id:string;label:string;text:string;sources:string[]}>;
  crossChecks?:CrossFileCheck[];
  /** Reading reminders (focus notes) for this field; never change a conclusion. */
  guidanceNotes?:GuidanceRef[];
  /** Reading-only sources when no bank cross-file comparison applies. */
  sourceValues?:CrossFileValue[];
}
export interface ChecklistDocument {id:string;filename:string;parseRevision:string|null;directoryRevision:number|null;state:string;adopted:boolean}
export interface ReviewChecklist {
  caseId:string;caseRevision:number;roundId:string|null;roundNumber:number|null;configurationReleaseId:string|null;
  readOnly:boolean;rows:ChecklistRow[];documents:ChecklistDocument[];
}
