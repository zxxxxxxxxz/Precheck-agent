import {bottom,formFold,lineLabel,right,rightOfLabel,type FormLine} from './director-notice-source.js';

/** Only the identity-card row inside this director's own identification block.
 * A partial number remains partial; the passport beneath it is a different field. */
export function annualDirectorIdentity(lines:FormLine[]){
  const heading=lines.find(l=>/^(?:身分識別|身份识别|identification)/u.test(formFold(l.text)));
  if(!heading)return null;
  const passport=lines.find(l=>l.box.y>heading.box.y&&/^(?:\(b\))?(?:護照|护照|passport)/u.test(formFold(l.text)));
  if(!passport)return null;
  const own=lines.filter(l=>l.box.y>bottom(heading.box)&&bottom(l.box)<passport.box.y);
  const labels=['Partial Number of Hong Kong Identity Card','Hong Kong Identity Card Number','香港身分證部分號碼','香港身份证部分号码'];
  const value=rightOfLabel(own,labels,s=>s.length<=80&&/\d/u.test(s)&&/^[A-Z0-9*＊×Xx•·()（） /-]+$/u.test(s));
  if(!value)return null;
  const masks=own.filter(l=>l.box.x>right(value.value.box)&&/^[*＊×•\s]+$/u.test(l.text)&&Math.abs(l.box.y-value.value.box.y)<value.value.box.height);
  return {parts:[value.value,...masks],context:[heading,value.label],partial:/partial|部分/u.test(formFold(value.label.text))||masks.length>0,masked:masks.length>0};
}

/** Issue date means the signed return's date, never its made-up/as-at date.
 * Require the statement + signature block and an explicit DD/MM/YYYY legend. */
export function annualReturnIssueDate(lines:FormLine[]){
  const statement=lines.find(l=>/^(?:16)?(?:陳述書|陈述书|statement)/u.test(formFold(l.text)));
  if(!statement)return null;
  const signed=lines.filter(l=>l.box.y>statement.box.y&&/^(?:簽署|签署|signed)(?:signed)?[:：]?$/u.test(formFold(l.text)));
  if(signed.length!==1)return null;
  const own=lines.filter(l=>l.box.y>bottom(signed[0]!.box));
  const label=own.filter(l=>lineLabel(l,['日期 Date','日期','Date']));
  if(label.length!==1)return null;
  const dateLabel=label[0]!;
  const values=own.filter(l=>l.box.x>=right(dateLabel.box)&&Math.abs(l.box.y-dateLabel.box.y)<dateLabel.box.height*1.5&&/^(?:\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{4}|\d{1,4})$/u.test(l.text)).sort((a,b)=>a.box.x-b.box.x);
  const digits=values.length===1?values[0]!.text.split(/\s*[/.-]\s*/u):values.map(l=>l.text);
  if(digits.length!==3||!/^\d{4}$/u.test(digits[2]!))return null;
  const legend=own.filter(l=>l.box.y>=Math.max(...values.map(l=>bottom(l.box)))-2&&l.box.y<bottom(dateLabel.box)+dateLabel.box.height*2&&l.box.x>=dateLabel.box.x&&/dd|mm|yyyy/u.test(formFold(l.text)));
  if(!/dd.*mm.*yyyy/u.test(legend.map(l=>formFold(l.text)).join('')))return null;
  const iso=`${digits[2]}-${digits[1]!.padStart(2,'0')}-${digits[0]!.padStart(2,'0')}`,date=new Date(iso+'T00:00:00Z');
  if(Number.isNaN(date.valueOf())||date.toISOString().slice(0,10)!==iso)return null;
  return {parts:values,context:[statement,signed[0]!,dateLabel,...legend],iso};
}
