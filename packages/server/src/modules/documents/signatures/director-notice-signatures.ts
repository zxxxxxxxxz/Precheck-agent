import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {AutomaticSignatureRecord,AutomaticSignatureValue} from '@hsbc/contracts/signature-information';
import {directorNoticeLayout,formBox,bottom,right,rightOfLabel,type FormLine} from '../director-notice-source.js';

/** Form signature blocks have their own owners and dates. Officer details,
 * consent, and the final notice signature are not interchangeable. */
export function directorNoticeSignatures(page:DocumentPageArtifact,directoryRevision:number):AutomaticSignatureRecord[]|null {
  const layout=directorNoticeLayout(page);if(!layout)return null;
  const records:AutomaticSignatureRecord[]=[];
  const refs=(lines:FormLine[])=>page.anchors.filter(a=>a.document_version_id===page.scope.documentVersionId&&a.parse_revision===page.scope.parseRevision&&a.page_number===page.page.page_number&&
    a.block_ids.some(id=>lines.some(l=>l.region.region_id===id))).map(a=>({documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,directoryRevision,anchorId:a.anchor_id}));
  const value=(label:string,line:FormLine):AutomaticSignatureValue=>({label,value:line.text,evidence:refs([line]),box:line.box});
  for(const section of layout.sections.filter(s=>s.kind==='consent'||s.kind==='submission')){
    const lines=layout.lines.filter(l=>l.box.y>section.top&&bottom(l.box)<section.end);
    const signing=lines.filter(l=>/^(?:簽署|签署)?\s*Signed\s*[:：]?$/iu.test(l.text));
    if(signing.length!==1)continue;
    const slot=signing[0]!;
    const names=lines.filter(l=>/^[\p{Script=Han}·\s]+\s*[/／]\s*[A-Z][A-Z .'-]+$/u.test(l.text)&&
      l.box.x>right(slot.box)-8&&Math.abs(l.box.y-slot.box.y)<page.page.height*.045);
    if(names.length!==1)continue;
    const name=names[0]!;
    const dates=lines.filter(l=>/^\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4}$/u.test(l.text)&&l.box.x>=name.box.x-5&&Math.abs(l.box.y-name.box.y)<page.page.height*.04);
    const validDates=dates.filter(l=>{
      const [d,m,y]=l.text.split('/').map(s=>s.trim()),iso=`${y}-${m!.padStart(2,'0')}-${d!.padStart(2,'0')}`,v=new Date(iso+'T00:00:00Z');
      return !Number.isNaN(v.valueOf())&&v.toISOString().slice(0,10)===iso;
    });
    // A nearby printed role containing alternatives needs a visual strike-out
    // check. Neither a template's Director option nor a name asserts a signature.
    const roleLines=lines.filter(l=>l.box.y>=bottom(name.box)&&l.box.y<bottom(name.box)+page.page.height*.04&&/董事|秘書|秘书|Director|Secretary/iu.test(l.text));
    // Optional details must be explicitly labelled in this signing block, not
    // borrowed from the officer or protected-information sections above it.
    const details=lines.filter(l=>l.box.y>=Math.min(name.box.y,slot.box.y)&&bottom(l.box)<=Math.max(bottom(name.box),bottom(slot.box))+page.page.height*.06);
    const optionalValue=(label:string,labels:string[])=>{
      const labelled=rightOfLabel(details,labels,text=>!!text.trim()&&!/^(?:N\/?A|不適用|不适用|[_—–-]+)$/iu.test(text.trim()));
      const inline=details.flatMap(line=>{
        const match=/^([^:：]+)[:：]\s*(\S.*?)\s*$/u.exec(line.text);
        return match&&labels.some(name=>name.toLowerCase()===match[1]!.trim().toLowerCase())&&!/^(?:N\/?A|不適用|不适用|[_—–-]+)$/iu.test(match[2]!)?[{...value(label,line),value:match[2]!}]:[];
      });
      const candidates=[...(labelled?[value(label,labelled.value)]:[]),...inline];
      return candidates.length===1?candidates[0]!:null;
    };
    const role=optionalValue('职位',['职位','職位','职务','職務','Position','Title','Capacity'])??(roleLines.length===1&&!/Secretary|秘書|秘书/u.test(roleLines[0]!.text)&&/^董事\s*Director$/iu.test(roleLines[0]!.text)?value('职位',roleLines[0]!):null);
    const number=optionalValue('证件号码',['证件号码','證件號碼','身份证号码','身份證號碼','HKID','HKID No.','Passport No.','Identification number']);
    // Consent places ink left of the printed name; submission places it above
    // the name. Bound the signing space separately from the printed identity,
    // date and role so those observations cannot replace a handwriting result.
    const aboveName=name.box.x-right(slot.box)<page.page.width*.06;
    const slotTop=Math.max(section.top,Math.min(name.box.y,slot.box.y)-page.page.height*.03);
    const slotLeft=Math.max(0,right(slot.box)-page.page.width*.015);
    const slotRight=aboveName?right(name.box):name.box.x-3;
    const slotBottom=aboveName?name.box.y-2:Math.max(bottom(name.box),bottom(slot.box));
    const signingBox={x:slotLeft,y:slotTop,width:Math.max(1,slotRight-slotLeft),height:Math.max(1,slotBottom-slotTop)};
    const nearby=page.regions.filter(r=>{
      if(!['signature','image'].includes(r.kind)||r.processing_status!=='ready'||r.page_asset_id!==page.page.page_asset_id||r.document_version_id!==page.scope.documentVersionId||r.parse_revision!==page.scope.parseRevision)return false;
      const b=formBox(r);return b&&b.width>30&&b.width<page.page.width*.4&&b.height>15&&b.height<page.page.height*.1&&
        b.x>=signingBox.x-3&&right(b)<=right(signingBox)+3&&b.y>=signingBox.y-3&&bottom(b)<=bottom(signingBox)+3&&
        (r.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility');
    });
    const graphic=nearby.length===1?nearby[0]:undefined;
    const signingEvidence=graphic?page.anchors.filter(a=>a.block_ids.includes(graphic.region_id)).map(a=>({documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,directoryRevision,anchorId:a.anchor_id})):refs([slot]);
    records.push({id:`nd2a-signature:${page.page.page_number}:${section.kind}:${slot.region.region_id}`,label:section.kind==='consent'?'出任董事职位同意书':'通知书签署',pageNumber:page.page.page_number,
      box:graphic?formBox(graphic)!:signingBox,presence:graphic?'graphic':'unknown',name:value('签署栏打印姓名',name),role,number,
      dates:validDates.length===1?[value(section.kind==='consent'?'同意书签署日期':'通知书签署日期',validDates[0]!)]:[],evidence:signingEvidence,
      uncertainText:[name,...validDates].some(l=>page.conflicts.some(c=>c.region_ids.includes(l.region.region_id)))});
  }
  return records;
}
