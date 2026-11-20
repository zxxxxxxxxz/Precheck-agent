import type {CaseSummary} from './types.ts';

const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'});

export function caseListStatus(item: CaseSummary) {
  return item.lifecycle === 'closed' || item.closure ? 'closed' : item.stage ?? item.preReviewStatus ?? item.status;
}

export function matchesCaseListStatus(item: CaseSummary, status?: string) {
  return !status || caseListStatus(item) === status;
}

export function caseListOverview(items: CaseSummary[], now = new Date()) {
  const today = businessDate.format(now);
  const open = items.filter(item => caseListStatus(item) !== 'closed');
  return {
    active: open.length,
    preparing: open.filter(item => ['preparing', 'collecting_materials'].includes(item.preReviewStatus ?? item.status)).length,
    reviewing: open.filter(item => item.preReviewStatus === 'reviewing').length,
    updatedToday: items.filter(item => {
      const updated = new Date(item.updatedAt);
      return Number.isFinite(updated.getTime()) && businessDate.format(updated) === today;
    }).length,
  };
}

export function caseListPage(rawPage: string | null, pageSize: number, total: number) {
  const requested = Number(rawPage);
  return Math.min(Number.isSafeInteger(requested) && requested > 0 ? requested : 1, Math.max(1, Math.ceil(total / pageSize)));
}
