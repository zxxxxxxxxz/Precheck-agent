import type {PoolClient} from 'pg';
import type {ReviewEvidence,ReviewState} from '@hsbc/contracts/review';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import {AppError} from '../../shared/errors.js';
import type {Actor} from '../identity/types.js';
import type {DocumentService} from '../documents/service.js';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import type {CaseAssistContext} from './context.js';
import type {CaseAssistCard,CaseAssistLegalOutput,CaseAssistLegalPoint} from '@hsbc/contracts/case-assistant';

/** Meeting draft; shown as awaiting business/legal confirmation, never as an approved bank rule. */
export const LEGAL_BASELINE_DRAFT=[
  {ref:'B1',label:'底线草稿 B1（待业务／法务确认）',statement:'不得把文件真实有效、已正式签署、无瑕疵等本应由意见得出的结论作为假设前提。'},
  {ref:'B2',label:'底线草稿 B2（待业务／法务确认）',statement:'意见所列生效前提或后续事项（备案、登记、批准、印花税或其他费用、通知）须逐项列出，由人工确认是否已满足。'},
] as const;
export interface LegalContext {
  documents:Array<{documentId:string;filename:string}>;
  chunks:Array<{blockId:string;filename:string;text:string;evidence:ReviewEvidence|null}>;
  baselines:Array<{ref:string;label:string;statement:string}>;
  limitations:string[];
}
const MAX_CHUNKS=40,MAX_BYTES=60_000;

/** Reads adopted legal-opinion materials of the viewed round with the sender's own document access. */
export async function legalMaterials(db:PoolClient,actor:Actor,caseId:string,state:ReviewState,documents:Pick<DocumentService,'reviewBundle'>,
  evidenceFromBundle:(bundle:DocumentBundle,filename:string,confirmed?:boolean)=>AnalysisEvidence[]):Promise<LegalContext>{
  const legalTypes=new Set((state.configuration?.taxonomy??[]).filter(t=>t.id.endsWith('_legal')||t.label.includes('法律意见')).map(t=>t.id));
  const pins=state.materials.filter(m=>m.operation==='adopt'&&legalTypes.has(m.documentTypeId));
  const names=Object.fromEntries((await db.query('SELECT id,filename FROM business.document_versions WHERE case_id=$1',[caseId])).rows.map(r=>[r.id,r.filename]));
  const context:LegalContext={documents:[],chunks:[],baselines:[],limitations:[]};
  let bytes=0,skipped=0;
  for(const pin of [...new Map(pins.map(p=>[p.documentVersionId,p])).values()]){
    const filename=names[pin.documentVersionId]??'法律意见书';context.documents.push({documentId:pin.documentVersionId,filename});
    let evidence:AnalysisEvidence[];
    try{evidence=evidenceFromBundle(await documents.reviewBundle(db,actor,caseId,pin) as DocumentBundle,filename,true);}
    catch(error){if(!(error instanceof AppError)||error.status===403)throw error;context.limitations.push(`${filename}：原文暂不可完整读取（${error.code}）。`);continue;}
    for(const e of evidence){
      const size=Buffer.byteLength(e.text);
      if(context.chunks.length>=MAX_CHUNKS||bytes+size>MAX_BYTES){skipped++;continue;}
      bytes+=size;context.chunks.push({blockId:`legal:${context.chunks.length+1}`,filename,text:e.text,evidence:e.locations[0]??null});
      if(e.warnings.length)context.limitations.push(`${filename} 有部分段落未能完整解析或定位，请核对原件。`);
    }
  }
  if(!context.documents.length)context.limitations.push('本轮尚未采用法律意见书材料；请先在“案件与上传”中归类并采用。');
  if(skipped)context.limitations.push(`法律意见书较长，本次只覆盖前 ${context.chunks.length} 段，其余 ${skipped} 段未分析。`);
  context.limitations=[...new Set(context.limitations)];
  return context;
}

export function legalBlocks(context:CaseAssistContext&{legal?:LegalContext},message:string):Array<{id:string;text:string}> {
  const legal=context.legal;if(!legal?.chunks.length)throw new AppError(409,'assistant_legal_material_required');
  const baselines=[...context.rules.filter(r=>r.kind==='legal_baseline').map(r=>({ref:r.ref,label:r.label,statement:r.statement})),...LEGAL_BASELINE_DRAFT];
  legal.baselines=baselines;
  return [
    {id:'baselines',text:baselines.map(b=>`${b.ref}（${b.label}）：${b.statement}`).join('\n')},
    {id:'message',text:message},
    ...legal.chunks.map(c=>({id:c.blockId,text:c.text})),
  ];
}

/** Every point must quote its own legal-opinion block verbatim; nothing is approved or rejected. */
export function legalReply(legal:LegalContext|undefined,output:CaseAssistLegalOutput,sourceRef:(wire:string)=>string){
  const notes:string[]=[],points:CaseAssistLegalPoint[]=[];
  for(const point of output.points){
    let local:string;try{local=sourceRef(point.sourceRef);}catch{notes.push('部分要点引用了无效的原文编号，已忽略。');continue;}
    const chunk=legal?.chunks.find(c=>c.blockId===local);
    if(!chunk||!chunk.text.includes(point.quote)){notes.push('部分要点的引文与原文不一致，已忽略。');continue;}
    const baseline=point.baselineRef?legal?.baselines.find(b=>b.ref===point.baselineRef):undefined;
    if(point.baselineRef&&!baseline)notes.push('部分要点引用的底线编号不存在，已按普通要点显示。');
    points.push({category:baseline||point.category!=='baseline'?point.category:'qualification',summary:point.summary,quote:point.quote,filename:chunk.filename,evidence:chunk.evidence,baselineLabel:baseline?.label??null});
  }
  const cards:CaseAssistCard[]=[{kind:'legal',documents:legal?.documents.map(d=>d.filename)??[],points,limitations:[...new Set([...(legal?.limitations??[]),...notes])]}];
  return {intent:'legal_opinion' as const,text:output.reply,cards,notes:[]};
}
