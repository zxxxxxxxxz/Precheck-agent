import type {AutomaticSignatureRecord} from '@hsbc/contracts/signature-information';

const normalized=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim().toLocaleUpperCase('en-US');
function names(value:string){
  const text=value.normalize('NFKC').trim(),aliases=[normalized(text)];
  // Only explicit adjacent bilingual printing yields aliases. No initials,
  // substring matching, name-order swapping or handwriting recognition.
  const latin='[A-Za-z][A-Za-z .’\'-]*',han='[\\p{Script=Han}·]+';
  const pair=new RegExp(`^(${latin})\\s+(${han})$`,'u').exec(text)??new RegExp(`^(${han})\\s+(${latin})$`,'u').exec(text);
  if(pair)aliases.push(normalized(pair[1]!),normalized(pair[2]!));
  return aliases;
}
const capacity=(s:string)=>normalized(s).replace(/^CHAIR(?:MAN)? AND DIRECTOR$/u,'DIRECTOR');
const samePerson=(a:AutomaticSignatureRecord,b:AutomaticSignatureRecord)=>a.pageNumber===b.pageNumber&&a.name&&b.name&&a.role&&b.role&&
  capacity(a.role.value)===capacity(b.role.value)&&names(a.name.value).some(n=>names(b.name!.value).includes(n));

/** Link only one execution block to one explicitly identified specimen row on
 * the same immutable page. Duplicate names, roles and existing conflicting
 * numbers stay separate. The number retains its own label and source anchors. */
export function associateSpecimenIdentities(records:AutomaticSignatureRecord[]):AutomaticSignatureRecord[]{
  const specimens=records.filter(r=>r.purpose==='specimen'&&r.name&&r.role);
  const executions=records.filter(r=>r.purpose==='execution'&&r.name&&r.role);
  return records.map(record=>{
    if(record.purpose!=='execution'||record.number)return record;
    const matching=specimens.filter(s=>samePerson(record,s));
    if(matching.length!==1)return record;
    const specimen=matching[0]!;
    if(!specimen.number?.value.trim()||!specimen.number.evidence.length||executions.filter(e=>samePerson(e,specimen)).length!==1)return record;
    return {...record,number:structuredClone(specimen.number),numberAssociation:{recordId:specimen.id,method:'unique_same_page_specimen_name_and_capacity' as const},
      uncertainText:record.uncertainText||specimen.uncertainText};
  });
}
