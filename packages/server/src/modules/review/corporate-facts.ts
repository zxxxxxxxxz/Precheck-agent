import type {ReviewFacts} from '@hsbc/contracts/review-config';

/** Derived values are rebuilt from confirmed evidence, never accepted from OCR
 * or a caller's value for the derived field. Missing scope stays unknown. */
export function deriveCorporateFacts(facts:ReviewFacts):void {
 const value=(id:string)=>facts[id]?.state==='present'?facts[id]!.value:null;
 const derive=(id:string,result:string|null,dependencies:string[])=>{facts[id]={value:result,state:result===null?'uncertain':'present',evidenceIds:dependencies.flatMap(key=>facts[key]?.evidenceIds??[])};};
 derive('cgt_yes','yes',[]);
 const option=value('cgt_rm_option');
 derive('cgt_rm_valid_option',option==='a'||option==='b'?'yes':option==='none'||option==='both'?'no':null,['cgt_rm_option']);
 const country=value('cgt_jurisdiction'),kind=value('cgt_resolution_kind'),quorum=value('cgt_charter_minimum');
 const validKind=kind==='board'||kind==='shareholders';
 const count=typeof quorum==='string'&&/^[1-9]\d{0,3}$/.test(quorum)?quorum:null;
 derive('cgt_resolution_minimum',country==='HK'&&kind==='board'?'1':typeof country==='string'&&/^[A-Z]{2}$/.test(country)&&validKind?count:null,['cgt_jurisdiction','cgt_resolution_kind','cgt_charter_minimum']);
 const signers=value('cgt_resolution_signer_count');
 if(signers!==null&&(typeof signers!=='string'||!/^\d{1,4}$/.test(signers)))derive('cgt_resolution_signer_count',null,['cgt_resolution_signer_count']);
}
