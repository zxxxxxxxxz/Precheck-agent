import type {ReviewState} from '@hsbc/contracts/review';
import type {Material} from './types.ts';
import type {UploadState} from './upload-queue.ts';

/** These are preparation gates, not a claim that documents satisfy the review rules. */
export function roundPreparation(state: ReviewState | undefined, files: Material[], uploads: UploadState[], unavailable = false) {
  const active = uploads.some(upload => upload.queued || upload.transmitting || !!upload.upload && ['issued', 'verifying'].includes(upload.upload.state));
  const failed = uploads.filter(upload => !upload.canceled && !upload.queued && !upload.transmitting &&
    (upload.error || upload.localError || ['rejected', 'expired'].includes(upload.upload?.state ?? ''))).length;
  const processing = files.some(file => ['queued', 'pending', 'running'].includes(file.parseStatus));
  const reason = unavailable || !state ? '正在确认本轮材料与权限，请稍后重试。'
    : state.readOnly ? '本轮已锁定，可查看审查和结果。'
    : !state.allowedActions.includes('case:start') ? '当前账号无权开始本轮预审。'
    : !state.configurationReleaseId ? '请先选择本轮审核配置。'
    : active ? '文件仍在上传或核验，请等待登记完成。'
    : failed ? `有 ${failed} 份文件上传未完成。请重新上传，或取消上传后继续。`
    : !files.length ? '请先上传本轮文件，登记成功后才能开始预审。'
    : processing ? '材料正在提取，请等待处理结束后核对并开始。'
    : state.runs.some(run => ['pending', 'running'].includes(run.state)) ? '本轮预审正在执行。'
    : undefined;
  return {disabled: !!reason, reason, failed};
}
