import {createCanvas,type SKRSContext2D} from '@napi-rs/canvas';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Public synthetic ink/seal controls, not genuine signatures or identity proof.
 * Expected regions are fixed before any model execution. */
export async function generateSignatureControls(outputDirectory:string){
  const output=resolve(outputDirectory);await mkdir(output,{recursive:false,mode:0o700});
  const width=1024,height=768;
  type Box=[number,number,number,number];
  type Expected={kind:'handwriting'|'stamp'|'blank_signing_slot'|'printed_name'|'uncertain';bbox:Box};
  const records:Array<{id:string;file:string;sha256:string;width:number;height:number;expected:Expected[];assertNoPositive?:boolean;requiresUncertainty?:boolean}>=[];
  const ink=(ctx:SKRSContext2D)=>{ctx.strokeStyle='#111111';ctx.lineWidth=5;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(220,460);ctx.bezierCurveTo(200,450,310,250,330,290);ctx.bezierCurveTo(350,350,240,480,300,430);ctx.bezierCurveTo(360,360,320,500,390,405);ctx.bezierCurveTo(420,375,385,460,450,415);ctx.bezierCurveTo(480,365,440,480,510,410);ctx.bezierCurveTo(540,385,520,450,600,390);ctx.stroke();ctx.beginPath();ctx.moveTo(200,480);ctx.bezierCurveTo(350,440,560,460,660,430);ctx.stroke();};
  const seal=(ctx:SKRSContext2D,color:string)=>{ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=7;for(const radius of[145,133]){ctx.beginPath();ctx.arc(512,380,radius,0,2*Math.PI);ctx.stroke();}ctx.font='bold 25px sans-serif';ctx.textAlign='center';ctx.fillText('SYNTHETIC COMPANY',512,330);ctx.fillText('TEST SEAL',512,435);ctx.lineWidth=3;ctx.beginPath();for(let i=0;i<10;i++){const angle=-Math.PI/2+i*Math.PI/5,r=i%2?17:38,x=512+Math.cos(angle)*r,y=378+Math.sin(angle)*r;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);}ctx.closePath();ctx.stroke();ctx.textAlign='start';};
  const add=async(id:string,draw:(ctx:SKRSContext2D)=>void,expected:Expected[],extra:{assertNoPositive?:boolean;requiresUncertainty?:boolean}={})=>{
    const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.font='20px sans-serif';ctx.fillStyle='#444444';ctx.fillText('PUBLIC SYNTHETIC CONTROL — NO IDENTITY CLAIM',40,40);draw(ctx);
    const image=canvas.toBuffer('image/png'),file=id+'.png';await writeFile(resolve(output,file),image,{mode:0o600});records.push({id,file,sha256:createHash('sha256').update(image).digest('hex'),width,height,expected,...extra});
  };
  await add('hand_drawn_ink',ink,[{kind:'handwriting',bbox:[190,270,675,495]}]);
  await add('red_seal',ctx=>seal(ctx,'#b00000'),[{kind:'stamp',bbox:[360,228,665,532]}]);
  await add('black_seal',ctx=>seal(ctx,'#111111'),[{kind:'stamp',bbox:[360,228,665,532]}]);
  await add('rotated_ink',ctx=>{ctx.translate(512,384);ctx.rotate(-Math.PI/9);ctx.translate(-512,-384);ink(ctx);},[{kind:'handwriting',bbox:[170,290,680,575]}]);
  await add('overlapping_marks',ctx=>{seal(ctx,'#b00000');ink(ctx);},[{kind:'uncertain',bbox:[190,228,675,532]}],{requiresUncertainty:true});
  await add('low_resolution',ctx=>{const tiny=createCanvas(32,24),small=tiny.getContext('2d');small.fillStyle='white';small.fillRect(0,0,32,24);small.scale(32/width,24/height);seal(small,'#333333');ctx.imageSmoothingEnabled=false;ctx.drawImage(tiny,0,0,width,height);},[{kind:'uncertain',bbox:[330,210,700,560]}],{requiresUncertainty:true});
  await add('blank_signing_slot',ctx=>{ctx.fillStyle='#111111';ctx.font='28px sans-serif';ctx.fillText('Director signature:',150,300);ctx.strokeStyle='#111111';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(420,310);ctx.lineTo(850,310);ctx.stroke();},[{kind:'blank_signing_slot',bbox:[130,265,870,325]}],{assertNoPositive:true});
  await add('printed_signer',ctx=>{ctx.fillStyle='#111111';ctx.font='28px sans-serif';ctx.fillText('Director name (printed): ALICE EXAMPLE',150,300);},[{kind:'printed_name',bbox:[130,265,900,320]}],{assertNoPositive:true});
  await add('table_logo_watermark',ctx=>{ctx.save();ctx.translate(512,384);ctx.rotate(-Math.PI/6);ctx.fillStyle='#e8e8e8';ctx.font='bold 75px sans-serif';ctx.textAlign='center';ctx.fillText('SYNTHETIC MOCK',0,0);ctx.restore();ctx.strokeStyle='#111111';ctx.lineWidth=2;for(let y=180;y<600;y+=70){ctx.beginPath();ctx.moveTo(100,y);ctx.lineTo(900,y);ctx.stroke();}for(let x=100;x<=900;x+=200){ctx.beginPath();ctx.moveTo(x,180);ctx.lineTo(x,530);ctx.stroke();}ctx.fillStyle='#222222';ctx.fillRect(100,80,55,55);ctx.fillStyle='white';ctx.font='bold 28px sans-serif';ctx.fillText('M',115,118);ctx.fillStyle='#111111';ctx.font='24px sans-serif';ctx.fillText('MOCK COMPANY — LOGO',180,118);ctx.fillText('Printed table text only',120,230);},[],{assertNoPositive:true});
  const manifest={schemaVersion:1,evaluationGroup:'independent_public_synthetic_controls',genuineHandwriting:false,identityClaim:false,width,height,records};
  await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});return manifest;
}
if(process.argv[1]?.endsWith('signature-controls.ts')){
  const path=process.argv[2];if(!path)throw new Error('Output directory required');
  generateSignatureControls(path).then(manifest=>console.log(JSON.stringify({generated:manifest.records.length,evaluationGroup:manifest.evaluationGroup}))).catch(()=>{process.stderr.write('Synthetic control generation failed\n');process.exitCode=1;});
}
