export interface WorkspaceCase {
  caseId: string;
  activeTab: string;
  tabs: {key: string; to: string}[];
}

export function caseMaterialsPath(caseId: string, roundId?: string | null) {
  return `/cases/${encodeURIComponent(caseId)}/materials${roundId ? `?round=${encodeURIComponent(roundId)}` : ''}`;
}

export function caseExtractionPath(caseId: string, roundId?: string | null) {
  const params = new URLSearchParams({mode: 'reader', panel: 'fields'});
  if (roundId) params.set('round', roundId);
  return `/cases/${encodeURIComponent(caseId)}/review?${params}`;
}

export function reviewResultsPath(caseId: string, roundId?: string | null) {
  return `/cases/${caseId}/reports${roundId ? `?round=${encodeURIComponent(roundId)}` : ''}`;
}

/** Reuse each tab's remembered query. The review journey enters the field desk;
 * direct reader links keep their existing document/source parameters. */
export function workspaceSteps(item?: WorkspaceCase) {
  const destination = (key: string, desk = false) => {
    const target = item?.tabs.find(tab => tab.key === key)?.to;
    if (!target) return undefined;
    if (key === 'materials' && item) return caseMaterialsPath(item.caseId, new URLSearchParams(target.split('?')[1]).get('round'));
    if (!desk) return target;
    const [path, query] = target.split('?');
    const params = new URLSearchParams(query);
    params.set('mode', 'business');
    params.set('tab', 'checklist');
    params.delete('manage');
    return `${path}?${params}`;
  };
  const current = item?.activeTab === 'review' ? 'desk' : ['reports', 'collaboration'].includes(item?.activeTab ?? '') ? 'result' : 'upload';
  return [
    {key: 'upload', label: '案件与上传', to: item ? destination('materials') : '/cases'},
    {key: 'desk', label: '提取审查', to: destination('review', true)},
    {key: 'result', label: '预审结果', to: destination('reports')},
  ].map((step, index) => ({...step, number: String(index + 1).padStart(2, '0'), active: step.key === current}));
}

/** Bare review entries open the field desk. Existing evidence URLs remain readers.
 * Explicit business links take precedence over remembered source parameters. */
export function reviewDestination(search: string, reviewLoop: boolean): 'business' | 'reader' {
  const params = new URLSearchParams(search);
  if (params.get('mode') === 'reader') return 'reader';
  if (params.get('mode') === 'business') return 'business';
  if (['document', 'parse', 'page', 'directory', 'anchor', 'sourceNode', 'view'].some(key => params.has(key))) return 'reader';
  return reviewLoop ? 'business' : 'reader';
}

export function readerDestination(target: string): string {
  const [path, query] = target.split('?');
  const params = new URLSearchParams(query);
  params.set('mode', 'reader');
  params.delete('tab');
  return `${path}?${params}`;
}
