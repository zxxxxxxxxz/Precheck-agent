import {can} from './features/identity/permissions.ts';
import {caseMaterialsPath, reviewResultsPath} from './features/cases/workspace-navigation.ts';

interface CaseLike {preReviewStatus?:string;status: string; allowed_actions: string[]}
/** List and work queue entries go straight to the current task. */
export function nextStep(caseId: string, item: CaseLike): {label: string; to: string} {
  if (item.preReviewStatus === 'closed') return {label: '查看历史', to: reviewResultsPath(caseId)};
  if (['results_pending', 'round_completed', 'execution_failed', 'canceled', 'stale', 'reviewing'].includes(item.preReviewStatus ?? '')) return {label: '查看预审', to: reviewResultsPath(caseId)};
  if (item.status === 'assignment_required') return {label: can(item.allowed_actions, 'case:assign') ? '指派经办人员' : '查看材料', to: caseMaterialsPath(caseId)};
  return {label: can(item.allowed_actions, 'material:upload') ? '登记材料' : '查看材料', to: caseMaterialsPath(caseId)};
}
