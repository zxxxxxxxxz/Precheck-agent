import type {CaseReviewProjection} from '@hsbc/contracts/case-review-status';
import type {CaseDetails} from '@hsbc/contracts/draft';
export interface CaseSummary extends Partial<CaseReviewProjection> {
  details?: CaseDetails;
  currentRoundId?:string|null; selectedRoundId?:string|null; roundsEnabled?:boolean;
  id: string; caseNumber?: string | null; title: string; reference: string | null; background: string | null; scenario: string;
  status: 'assignment_required' | 'collecting_materials'; revision: number;
  makerPersonId: string | null; makerDisplayName?: string; updatedAt: string; allowed_actions: string[];
}
