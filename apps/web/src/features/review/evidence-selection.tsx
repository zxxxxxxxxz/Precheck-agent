import React from 'react';
import {Button} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {DocumentPageArtifact, FieldsResponse} from '../documents/types.ts';
import type {SourceDocumentResponse} from '../../sourceDocument.ts';
import {api, ApiError, queryClient} from '../../api.ts';
import {ErrorNotice} from '../../ui.tsx';
import {evidenceUrl} from './presentation.ts';
import {evidenceIdentity, pageEvidencePreview, sourceEvidencePreview, type EvidencePreview} from './evidence-preview.ts';
import './evidence-selection.css';

export function SelectedEvidence({caseId, roundId, source, filename, preview, readable, remove}: {
  caseId: string; roundId?: string | null; source: ReviewEvidence; filename: string;
  preview?: EvidencePreview; readable: boolean; remove: () => void;
}) {
  const base = `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(source.documentVersionId)}`;
  const suffix = `?parseRevision=${encodeURIComponent(source.parseRevision)}`;
  const query = useQuery({
    queryKey: ['review-evidence-preview', caseId, evidenceIdentity(source)], enabled: readable,
    initialData: readable ? preview : undefined, staleTime: 60_000,
    queryFn: async () => {
      if (source.sourceNodeId) {
        const document = await queryClient.fetchQuery({queryKey: ['review-loop-evidence-source', caseId, source.documentVersionId, source.parseRevision], queryFn: ({signal}) => api<SourceDocumentResponse>(`${base}/source${suffix}`, {signal})});
        return sourceEvidencePreview(source, document) ?? null;
      }
      const fields = await queryClient.fetchQuery({queryKey: ['review-evidence-anchor-index', caseId, source.documentVersionId, source.parseRevision], queryFn: ({signal}) => api<FieldsResponse>(`${base}/fields${suffix}`, {signal})});
      if (fields.parseRevision !== source.parseRevision) throw new ApiError(409, 'evidence_version_mismatch', '原文版本不一致，请重新读取。');
      const anchor = fields.anchors.find(value => value.anchor_id === source.anchorId && value.document_version_id === source.documentVersionId && value.parse_revision === source.parseRevision);
      if (!anchor) return null;
      const page = await queryClient.fetchQuery({queryKey: ['review-loop-evidence-page', caseId, source.documentVersionId, source.parseRevision, anchor.page_number], queryFn: ({signal}) => api<DocumentPageArtifact>(`${base}/pages/${anchor.page_number}${suffix}`, {signal})});
      return pageEvidencePreview(source, page, anchor) ?? null;
    },
  });
  const data = readable && !query.error ? query.data : undefined;
  const url = evidenceUrl(caseId, {...source, pageNumber: data?.pageNumber}) + (roundId ? `&round=${encodeURIComponent(roundId)}` : '');
  return <li className="selected-evidence">
    <div className="selected-evidence-heading"><strong>{filename}</strong><span className="muted">{data?.location ?? (readable && query.isPending ? '正在读取位置…' : '原文位置待核对')}</span></div>
    <p className="selected-evidence-excerpt">{data?.excerpt || (data ? '此位置没有可显示的文字，请查看原文。' : !readable ? '当前无法读取原文摘要。' : query.isPending ? '正在读取原文摘要…' : '原文摘要暂不可用，请查看原文核对。')}</p>
    <div className="review-loop-toolbar-actions">{readable && <Link to={url} target="_blank" rel="noopener noreferrer" aria-label={`查看原文：${filename}，${data?.location ?? '所选位置'}（新窗口）`}>查看原文（新窗口）</Link>}<Button type="link" aria-label={`移除依据：${filename}，${data?.location ?? '所选位置'}`} onClick={remove}>移除</Button></div>
    {readable && <ErrorNotice error={query.error} retry={() => void query.refetch()}/>}
  </li>;
}
