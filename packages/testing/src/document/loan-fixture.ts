import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function syntheticLoanPdf(amount='1000000',pages=3){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=pages;n++){
    const page=pdf.addPage([600,800]);
    const lines=n===1?['LOAN AGREEMENT','1. Definitions','Borrower means Example Trading Limited.','Facility means the loan described in Clause 2.','2. Facility',`Loan amount: USD ${amount}`,'Maturity date: 2030-10-14','Subject to the conditions in Clause 3.']:
      n===pages?['BOARD RESOLUTION','The directors authorize the Facility described in Clause 2.','SIGNATURES','Signed by: Alex Morgan','Title: Director','Date: 2026-10-14']:
      ['LOAN AGREEMENT','3. Conditions','The Facility is available only after the Board Resolution.','Except as provided in Clause 2, no amount is due.','Annex A: Insurance schedule','Insured amount: USD 1200000'];
    for(const [i,line]of lines.entries())page.drawText(line,{x:50,y:740-i*38,size:i===0?18:13,font,color:rgb(0.08,0.08,0.08)});
    if(n===pages)page.drawSvgPath('M 0,15 C 20,-5 18,30 40,10 C 55,-5 55,28 80,4 C 100,-10 98,20 120,6',{x:140,y:page.getHeight()-260,borderWidth:1.7,borderColor:rgb(0.05,0.1,0.25)});
    page.drawText(`Synthetic evidence fixture | Page ${n}`,{x:50,y:30,size:9,font});
  }
  return Buffer.from(await pdf.save());
}
