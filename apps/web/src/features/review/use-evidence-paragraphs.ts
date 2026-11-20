import {useQuery} from '@tanstack/react-query';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {DocumentPageArtifact,FieldsResponse} from '../documents/types.ts';
import type {SourceDocumentResponse} from '../../sourceDocument.ts';
import {api,ApiError,queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {evidenceIdentity,pageEvidencePreview} from './evidence-preview.ts';
import {cleanEvidenceText,pageEvidenceParagraph,sourceEvidenceParagraph,sameEvidenceParagraph,type EvidenceParagraph} from './evidence-paragraph.ts';

export function useEvidenceParagraphs(caseId:string,evidence:ReviewEvidence[],focused=false) {
  const {session}=useAuth();
  return useQuery({queryKey:['field-evidence-paragraphs',session.user?.accountId,caseId,evidence.map(evidenceIdentity),focused],staleTime:60_000,
    queryFn:async()=>{
      const values=await Promise.all(evidence.map(async source=>{
        const base=`/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(source.documentVersionId)}`;
        const suffix=`?parseRevision=${encodeURIComponent(source.parseRevision)}`;
        if(source.sourceNodeId){
          const document=await queryClient.fetchQuery({queryKey:['review-loop-evidence-source',caseId,source.documentVersionId,source.parseRevision],queryFn:({signal})=>api<SourceDocumentResponse>(`${base}/source${suffix}`,{signal})});
          return {source,paragraph:sourceEvidenceParagraph(source,document),pageNumber:undefined};
        }
        const fields=await queryClient.fetchQuery({queryKey:['review-evidence-anchor-index',caseId,source.documentVersionId,source.parseRevision],queryFn:({signal})=>api<FieldsResponse>(`${base}/fields${suffix}`,{signal})});
        if(fields.parseRevision!==source.parseRevision||(source.directoryRevision!==null&&Number(fields.directoryRevision)!==source.directoryRevision))throw new ApiError(409,'evidence_version_mismatch','原文版本不一致，请重新读取。');
        const anchor=fields.anchors.find(a=>a.anchor_id===source.anchorId&&a.document_version_id===source.documentVersionId&&a.parse_revision===source.parseRevision);
        if(!anchor)return {source,paragraph:undefined,pageNumber:undefined};
        const page=await queryClient.fetchQuery({queryKey:['review-loop-evidence-page',caseId,source.documentVersionId,source.parseRevision,anchor.page_number],queryFn:({signal})=>api<DocumentPageArtifact>(`${base}/pages/${anchor.page_number}${suffix}`,{signal})});
        const preview=anchor.localization_status!=='unavailable'?pageEvidencePreview(source,page,anchor,true):undefined;
        const fallback:EvidenceParagraph|undefined=preview?.excerpt?{source,text:cleanEvidenceText(preview.excerpt),displayText:preview.excerpt,pageNumber:preview.pageNumber,location:preview.location,regionIds:anchor.block_ids}:undefined;
        const paragraph=focused?fallback:pageEvidenceParagraph(source,page,anchor)??fallback;
        return {source,paragraph,pageNumber:anchor.page_number};
      }));
      const groups:Array<{sources:ReviewEvidence[];paragraph?:EvidenceParagraph;pageNumber?:number}>=[];
      for(const {source,paragraph,pageNumber} of values){
        const group=paragraph&&groups.find(group=>group.paragraph&&sameEvidenceParagraph(group.paragraph,paragraph));
        if(group)group.sources.push(source);else groups.push({sources:[source],paragraph,pageNumber});
      }
      return groups;
    },
  });
}
