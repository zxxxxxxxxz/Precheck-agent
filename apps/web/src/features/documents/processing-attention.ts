import type {ProcessingStatus} from './types.ts';

import {describeProcessingNote} from '../../processing-notes.ts';
import {visibleProcessingGaps} from './diagnostic-visibility.ts';
export {visibleProcessingGap,visibleProcessingGaps} from './diagnostic-visibility.ts';

export function processingProblem(p:ProcessingStatus):string|null {
  const extraction=p.presentation?.extraction;
  if(p.status==='failed')return '文件处理失败';
  if(extraction?.status==='failed')return '字段提取失败';
  if(['pending','queued','running','processing'].includes(p.status)||['pending','queued','running'].includes(extraction?.status??''))return null;
  if(!['ready','partial','succeeded','completed'].includes(p.status))return null;
  if(p.errorCode||extraction?.errorCode)return '处理异常';
  if(p.progress?.totalPages!=null&&p.progress.completedPages<p.progress.totalPages)return '部分页面未处理';
  const gaps=visibleProcessingGaps(p.presentation?.coverageGaps??[]);
  if(gaps.some(code=>code.startsWith('page_not_processed:')||code==='cloud_field_pages_unreviewed'))return '部分页面未处理';
  if(gaps.some(code=>code==='cloud_completion_incomplete'))return '补查未完成';
  if(gaps.some(code=>/failed|unavailable/.test(code)))return '部分内容处理失败';
  const issue=gaps.find(code=>describeProcessingNote(code).category==='processing');
  if(issue)return describeProcessingNote(issue).title;
  // Older APIs do not identify why a job is partial. Never infer success from it.
  if((p.status==='partial'||extraction?.status==='partial')&&!p.presentation?.coverageGaps)return '处理结果待查询';
  return null;
}
export function pageProcessingLabel(page:{status:string;coverageGaps:readonly string[]}) {
  if(page.status==='failed')return '处理失败';
  if(!['ready','partial'].includes(page.status))return '待处理';
  return visibleProcessingGaps(page.coverageGaps).length?'有处理提示':'已处理';
}
