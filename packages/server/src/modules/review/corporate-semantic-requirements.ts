import {candidateAdoptionValue} from '@hsbc/contracts/documents';
import {fieldCandidateSelection} from './field-candidate-selection.js';
import {CORPORATE_LEGAL_INTRO,CORPORATE_LEGAL_OPINIONS,CORPORATE_LEGAL_FOOTNOTES,CORPORATE_RULE_ROWS,CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ChecklistInputDocument} from './checklist.js';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {ReviewState} from '@hsbc/contracts/review';
import {corporateValueDocuments} from './corporate-value-checks.js';

/** Executable content check of supplied clauses. The bank's matrix governs
 * whether an absent opinion must be obtained; it does not prevent reading an
 * already supplied opinion. Do not manufacture entity attribution or approval. */
export function corporateSemanticRequirement(check:CrossFileCheck,row:ChecklistRow,rows:ChecklistRow[],read:(r:ChecklistRow)=>CrossFileValue[],documents:ChecklistInputDocument[],state:ReviewState,manifest:ReviewConfigManifest):CrossFileCheck{
 if(!check.checklistRule)return check;
 const n=Number(/^cgt_legal_checklist_(\d+)$/u.exec(row.fieldId)?.[1]);
 if(!n||n>23)return check;
 const opinion=CORPORATE_LEGAL_OPINIONS[n-7];
 const text=n<=6?CORPORATE_LEGAL_INTRO[n-1]:opinion?.text;
 if(!text)return check;
 const contextIds:Record<number,string[]>={
  3:['cgt_legal_references','cgt_field_6','cgt_authorization_reference_date'],
  5:['cgt_legal_checklist_9','cgt_legal_checklist_10','cgt_legal_checklist_14'],
  11:['cgt_legal_checklist_9','cgt_legal_checklist_10'],
  14:['cgt_legal_checklist_4','cgt_legal_checklist_5'],
  18:['cgt_legal_references'],19:['cgt_field_62','cgt_field_5','cgt_legal_references'],
  20:['cgt_field_62','cgt_field_5','cgt_legal_references','cgt_legal_firm'],
  21:['cgt_field_62','cgt_legal_references'],22:['cgt_field_62','cgt_legal_references'],23:['cgt_field_62','cgt_legal_references'],
 };
 const context=(contextIds[n]??[]).flatMap(id=>{
  const r=rows.find(r=>r.fieldId===id&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
  return r?read(r).filter(s=>s.state==='available'&&s.values.length&&!s.warnings.length):[];
 });
 // The actual document inventory is available even before case object adoption.
 // It is a labelled system inventory, never a fabricated document quotation.
 if(n===3){
  const docs=[...new Map(documents.flatMap(d=>d.taxonomyIds.flatMap(t=>corporateValueDocuments(row,documents,state,t))).map(d=>[d.id,d])).values()];
  for(const d of docs)if(d.parseRevision&&d.directoryRevision)context.push({id:`${d.id}:inventory`,fieldId:'current_document_inventory',label:'当前文档列表（系统记录）',documentId:d.id,filename:d.filename,
   values:[JSON.stringify({filename:d.filename,materialTypes:d.taxonomyIds})],evidence:[],warnings:[],state:'available',extractionVersion:{parseRevision:d.parseRevision,directoryRevision:d.directoryRevision}});
 }
 // An expressly non-security guarantee does not need an opinion that it
 // creates a security interest. This is the bank's footnote, not a missing value.
 if(n===18&&check.sources.length&&check.sources.every(s=>s.state==='available'&&s.values.length&&!s.warnings.length&&s.values.every(v=>{
  const text=v.replace(/\s+/gu,'');
  return !/但是|然而|但另|另有|however|except|(?:当前|當前|本次)(?:应|應|须|須|需要)(?:创设|創設|设立|設立)/iu.test(text)&&
   /(?:不创设|不創設|不设立|不設立)[^。；]{0,100}(?:担保物权|擔保物權|抵押|质押|質押|押记|押記)/u.test(text);
 })))return {...check,outcome:'not_applicable',reason:'提取条款明确本保证不创设担保物权；银行清单意见项 11 仅适用于担保物权文件，本项不适用。',manualReasons:[],bankExecution:{version:'bank-value-checks-v1'},semanticEligible:false,
  checklistRule:{...check.checklistRule,text:`${text}\n${CORPORATE_LEGAL_FOOTNOTES[n]}`}};
 const kindRow=rows.find(r=>r.fieldId==='cgt_legal_firm'&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
 const kindDefinition=manifest.fields.find(f=>f.id==='cgt_legal_firm');
 let kindSources=kindRow?read(kindRow).filter(s=>s.state==='available'&&s.values.length&&!s.warnings.length):[];
 // A legacy manual recipe may still have real extracted firm/scope values.
 // Read them as document content, never as approval of the law firm's mandate.
 if(!kindSources.length&&kindRow&&kindDefinition&&!kindRow.fact)kindSources=corporateValueDocuments(row,documents,state,'cgt_legal').filter(d=>d.projectionCurrent&&['ready','partial'].includes(d.state)&&d.parseRevision&&d.directoryRevision&&!d.invalidFieldIds?.some(id=>id==='*'||id==='cgt_legal_firm')).flatMap(d=>{
  const candidates=d.fields.filter(f=>f.fieldId==='cgt_legal_firm'&&f.documentVersionId===d.id&&f.parseRevision===d.parseRevision).flatMap(f=>f.candidates.map((c,i)=>({id:`${f.id}:${i}`,value:c.displayValue??candidateAdoptionValue(c),confidence:c.confidence,documentId:d.id,evidence:[]})));
  const selection=fieldCandidateSelection(candidates,kindDefinition),values=selection?.values??[...new Set(candidates.flatMap(c=>c.value?[c.value]:[]))];
  return values.length?[{id:`${d.id}:opinion-kind`,fieldId:'cgt_legal_firm',label:kindRow!.label,documentId:d.id,filename:d.filename,values,evidence:[],warnings:[],state:'available' as const,extractionVersion:{parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision!}}]:[];
 });
 const combined=kindSources.length&&kindSources.every(s=>s.values.some(v=>/(?:综合意见|綜合意見|combined.{0,30}opinion|capacity\s+(?:legal\s+opinion\s+|opinion\s+)?(?:and|&|\+)\s+governing\s+law)/iu.test(v))&&s.values.every(v=>!/(?:非|不(?:是|属|屬|出具)|not\s+(?:a\s+)?)(?:综合|綜合|combined)/iu.test(v)));
 if(opinion?.matrix[0]==='X'&&combined)return {...check,outcome:'not_applicable',reason:'提取值已明确本文件为主体能力及管辖法综合意见；银行原清单在综合意见列将本项标为 X（不要求），不再强求额外肯定意见。',manualReasons:[],sources:[...check.sources,...kindSources],bankExecution:{version:'bank-value-checks-v1'},semanticEligible:false,
  checklistRule:{...check.checklistRule,text:`${text}\n原表综合意见列：X（不要求）。${CORPORATE_LEGAL_FOOTNOTES[n]??''}`}};
 const matrix=opinion?`\n原表矩阵（综合意见／仅主体能力意见／仅管辖法意见）：${opinion.matrix.map(v=>v||'必需').join('／')}。X 为不要求；Required if possible 为尽可能取得。`:'';
 const footnote=CORPORATE_LEGAL_FOOTNOTES[n];
 const documentRule=n===3?manifest.sources.find(s=>s.id==='cgt_rule_source_38'&&s.sha256===CORPORATE_WORKBOOK_SHA256&&s.disposition!=='excluded'):undefined;
 const bank38=CORPORATE_RULE_ROWS.find(r=>r.row===38)!;
 return {...check,manualReasons:[],sources:[...check.sources,...context],checklistRule:{...check.checklistRule,sources:[...check.checklistRule.sources,...(documentRule?[documentRule.reference]:[])],text:`本项中文含义：${row.rules.find(r=>r.id===check.checklistRule!.id)?.text.split(" 根据容量")[0]??row.label}\n银行原文：${text}${matrix}${footnote?`\n原表脚注：${footnote}`:''}${documentRule?`\n银行 Excel 第 38 行：${bank38.requirement}\n${bank38.notice}`:''}
本任务核对当前已提供条款是否表达银行所要求的内容，不独立证明律师陈述的法律事实。明确肯定的意见可以完成内容核对，无须再次提供律师用来形成意见的底层调查、批准、签名鉴定或身份确认。条件或例外仍须保留；不得把否定、未发表意见或不明确条款当作肯定意见。
前六项一般要求不受意见类型矩阵限制。其余已提供的肯定意见可以逐项核对内容，不因未人工选择意见类型而停住；若结论依赖脚注条件或明确排除适用，须依据已给条款与上下文说明。具体必需的值缺失、明确引用但未给出的关键例外才是缺口，不把 Company、Obligor、Guarantee 等在字段中明确使用的角色名一律当作缺失定义。${n!==3?'第 3 项须将审阅清单与当前文件列表核对，未提供的被引用材料如实列为缺口。':documentRule?'第 3 项须检查当前相关文件是否列于审阅清单；依银行 Excel 第 38 行，未提供的被引用材料亦如实列为缺口。':'第 3 项须检查当前相关文件是否列于审阅清单；不得仅因为审阅清单另外列有底层检索资料，就要求重新提供银行本项未要求的底层材料。'}`}};
}
