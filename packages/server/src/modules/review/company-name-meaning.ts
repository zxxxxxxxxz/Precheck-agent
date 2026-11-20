import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';

/** Exact complete company names, with an optional additional Chinese name.
 * No transliteration, substring company matching or legal entity inference. */
export function companyNameMeaning(raw:string):{english:string;chinese:string}|undefined{
 const text=raw.normalize('NFKC').replace(/(?:Name\s*\(in\s*block\s*letters\)|(?:Company|Guarantor|Customer|Borrower)\s+Name)\s*[:：]?/giu,'').trim();
 const english=/\b([A-Za-z][A-Za-z0-9 &'’().,/-]*?\b(?:LIMITED|LTD\.?|LLC|INCORPORATED|INC\.?|CORPORATION))(?=\s|[\p{Script=Han}()（）]|$)/iu;
 const single=text.replace(/\s+/gu,' '),match=english.exec(single);
 if(!match)return;
 const rest=single.replace(match[0],'').replace(/[\s()（）,，/]/gu,'');
 if(rest&&!/^[\p{Script=Han}·]+(?:公司|有限責任公司|有限责任公司)$/u.test(rest))return;
 return {english:match[1]!.replace(/\s+/gu,' ').toUpperCase(),chinese:rest};
}
/** The names of one company printed in different arrangements ("English 中文", "中文(English)", English alone) are the
 * same name. With every file read they are recorded as consistent. Where a file gave no value the comparison stays
 * incomplete, but the names that were read are not thereby different. Names that really differ are left as found. */
export function companyNameValueCheck(check:CrossFileCheck):CrossFileCheck{
 if(check.reason==='当前配置尚无本条银行原表的有效来源，请核对配置。'||check.method!=='text'||!check.bankRule||![8,10,14,27,30,42,44,53,60,66,70].includes(check.bankRule.row)||
  check.sources.length<2)return check;
 const read=check.sources.filter(s=>s.state==='available'&&s.documentId&&s.values.length&&!s.warnings.length),complete=read.length===check.sources.length;
 if(!complete&&(check.outcome!=='different'||read.length<2))return check;
 const names=read.flatMap(s=>s.values.map(companyNameMeaning));
 if(names.some(n=>!n))return check;
 const english=new Set(names.map(n=>n!.english)),chinese=new Set(names.flatMap(n=>n!.chinese?[n!.chinese]:[]));
 if(english.size!==1||chinese.size>1)return check;
 if(!complete)return {...check,outcome:'insufficient',reason:'已取得取值的各文件，完整英文公司名称相同，附带的中文名称互不冲突；仍有文件未取得本字段的取值，核对尚未完整，缺失不记为一致。'};
 return {...check,outcome:'consistent',reason:'各文件的完整英文公司名称相同；附带中文名称不改变本字段的名称含义，未发现相互冲突的中文名称。',manualReasons:[],bankExecution:{version:'bank-value-checks-v1'},semanticEligible:false};
}
