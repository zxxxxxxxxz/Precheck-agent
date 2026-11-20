import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute,resolve } from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import { MockOverlaySchema, MockValidationResultSchema, type MockOverlay, type MockValidationResult } from '@hsbc/contracts/mock-validation';
import { OcrParseResultSchema, type OcrParseResult } from '../../../document/ocr-client.js';
import { ServiceError } from '../../../infrastructure/integrations/http.js';

export const MOCK_FONT_SHA256='7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954';
export const mockDigest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export interface MockFontConfig {path:string;sha256:string;family:string}
export const DEFAULT_MOCK_FONT:MockFontConfig={path:'testdata/synthetic/fonts/DejaVuSans.ttf',sha256:MOCK_FONT_SHA256,family:'P2MockDejaVuSans'};
export function loadMockFont(env:NodeJS.ProcessEnv=process.env):MockFontConfig|undefined{
  const path=env.P2_MOCK_FONT_PATH,sha256=env.P2_MOCK_FONT_SHA256,family=env.P2_MOCK_FONT_FAMILY;
  if(path===undefined&&sha256===undefined&&family===undefined)return undefined;
  if(!path||!isAbsolute(path)||!sha256||!/^[a-f0-9]{64}$/.test(sha256)||!family||!/^[A-Za-z0-9 _-]{1,80}$/.test(family))throw new ServiceError('mock_font_configuration_invalid');
  return {path,sha256,family};
}
const fonts=new Map<string,Promise<{family:string;hasGlyph:(code:number)=>boolean}>>();
async function prepareFont(config:MockFontConfig){
  if(!/^[a-f0-9]{64}$/.test(config.sha256)||!/^[A-Za-z0-9 _-]{1,80}$/.test(config.family))throw new ServiceError('mock_font_configuration_invalid');
  const key=`${resolve(config.path)}:${config.sha256}:${config.family}`;
  if(!fonts.has(key))fonts.set(key,(async()=>{
    const bytes=await readFile(resolve(config.path));
    if(bytes.length>40*1024*1024||mockDigest(bytes)!==config.sha256)throw new ServiceError('mock_font_unavailable');
    const parsed=fontkit.create(bytes);
    if(!('hasGlyphForCodePoint'in parsed))throw new ServiceError('mock_font_collection_unsupported');
    // Hash in the private alias prevents an unrelated registration changing the face.
    const family=`${config.family}-${config.sha256.slice(0,16)}`;
    if(!GlobalFonts.register(bytes,family))throw new ServiceError('mock_font_unavailable');
    return {family,hasGlyph:(code:number)=>parsed.hasGlyphForCodePoint(code)};
  })());
  try{return await fonts.get(key)!;}catch(error){fonts.delete(key);throw error instanceof ServiceError?error:new ServiceError('mock_font_unavailable');}
}
export function pngDimensions(bytes:Buffer,maxPixels=16_000_000){
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(12,16).toString()!=='IHDR')throw new ServiceError('mock_png_required');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(!width||!height||width>10000||height>10000||width*height>maxPixels)throw new ServiceError('mock_pixel_budget_exceeded');
  return {width,height};
}
export function validateOverlayGeometry(overlays:MockOverlay[],width:number,height:number){
  if(!overlays.length||overlays.length>50)throw new ServiceError('mock_overlay_invalid');
  const ids=new Set<string>();
  for(const raw of overlays){
    const o=MockOverlaySchema.parse(raw),b=o.box;
    if(ids.has(o.id)||b.x+b.width>width||b.y+b.height>height)throw new ServiceError('mock_overlay_out_of_bounds');
    ids.add(o.id);
  }
  for(let i=0;i<overlays.length;i++)for(let j=0;j<i;j++){
    const a=overlays[i]!.box,b=overlays[j]!.box;
    if(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y)throw new ServiceError('mock_overlay_overlap');
  }
}

/** Copies RGBA pixels, then replaces only integer rectangles. No original object is written. */
export async function renderMockPage(original:Buffer,overlays:MockOverlay[],limits:{maxPixels?:number;maxBytes?:number;font?:MockFontConfig}={}){
  if(original.length>(limits.maxBytes??10*1024*1024))throw new ServiceError('mock_image_budget_exceeded');
  const {width,height}=pngDimensions(original,limits.maxPixels);validateOverlayGeometry(overlays,width,height);
  const fontConfig=limits.font??DEFAULT_MOCK_FONT,font=await prepareFont(fontConfig);
  for(const overlay of overlays)for(const character of overlay.text)if(!font.hasGlyph(character.codePointAt(0)!))throw new ServiceError('mock_font_glyph_missing');
  const image=await loadImage(original);
  if(image.width!==width||image.height!==height)throw new ServiceError('mock_image_dimensions_mismatch');
  const canvas=createCanvas(width,height),context=canvas.getContext('2d');context.drawImage(image,0,0);
  const originalPixels=context.getImageData(0,0,width,height),target=context.getImageData(0,0,width,height);
  const changed=new Uint8Array(width*height);
  for(const overlay of overlays){
    const b=overlay.box,tile=createCanvas(b.width,b.height),c=tile.getContext('2d');
    c.fillStyle='#ffffff';c.fillRect(0,0,b.width,b.height);c.fillStyle='#000000';c.font=`${overlay.fontSize}px "${font.family}"`;c.textBaseline='alphabetic';
    const m=c.measureText(overlay.text),inkWidth=m.actualBoundingBoxLeft+m.actualBoundingBoxRight,inkHeight=m.actualBoundingBoxAscent+m.actualBoundingBoxDescent;
    if(Math.max(m.width,inkWidth)>b.width-4||inkHeight>b.height-4)throw new ServiceError('mock_text_does_not_fit');
    c.fillText(overlay.text,2+Math.max(0,m.actualBoundingBoxLeft),2+m.actualBoundingBoxAscent);
    const pixels=c.getImageData(0,0,b.width,b.height).data;
    for(let y=0;y<b.height;y++){
      const offset=((b.y+y)*width+b.x)*4;
      target.data.set(pixels.subarray(y*b.width*4,(y+1)*b.width*4),offset);
      changed.fill(1,(b.y+y)*width+b.x,(b.y+y)*width+b.x+b.width);
    }
  }
  context.putImageData(target,0,0);
  const png=canvas.toBuffer('image/png');
  if(png.length>(limits.maxBytes??10*1024*1024))throw new ServiceError('mock_image_budget_exceeded');
  // Compare the decoded output, not only the in-memory drawing buffer.
  const roundtrip=createCanvas(width,height),r=roundtrip.getContext('2d');r.drawImage(await loadImage(png),0,0);
  const resultPixels=r.getImageData(0,0,width,height).data;
  for(let i=0;i<changed.length;i++)if(!changed[i])for(let c=0;c<4;c++)if(resultPixels[i*4+c]!==originalPixels.data[i*4+c])throw new ServiceError('mock_outside_pixels_changed');
  return {png,width,height,imageSha256:mockDigest(png),fontSha256:fontConfig.sha256,outsidePixelsUnchanged:true as const};
}
function distance(a:string,b:string){
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]!+1,row[j]!+1,row[j-1]!+(a[i-1]===b[j-1]?0:1));row=next;}
  return row[b.length]!;
}
/** Called only after OCR returns. Expected strings are never inputs to the model client. */
export function compareMockOcr(runId:string,png:Buffer,overlays:MockOverlay[],raw:OcrParseResult,fontSha256=MOCK_FONT_SHA256):MockValidationResult{
  const {width,height}=pngDimensions(png),parsed=OcrParseResultSchema.parse(raw);
  if(parsed.pages.length!==1)throw new ServiceError('mock_ocr_page_mismatch');
  const words=parsed.pages[0]!.word_ocr;
  if(!words||words.width!==width||words.height!==height)throw new ServiceError('mock_ocr_dimensions_mismatch');
  if(words.text_word.reduce((n,w)=>n+w.length,0)>20000)throw new ServiceError('mock_ocr_region_budget_exceeded');
  let clipped=false;
  const regions=words.text_word.flatMap((line,lineIndex)=>line.map((text,wordIndex)=>{
    const polygon=words.text_word_region[lineIndex]![wordIndex]!.map(([x,y])=>{
      if(x<0||y<0||x>width||y>height)clipped=true;
      return [Math.max(0,Math.min(width,x)),Math.max(0,Math.min(height,y))] as [number,number];
    });
    return {id:`mock:${runId}:word:${lineIndex}:${wordIndex}`,text,polygon,confidence:words.rec_scores[lineIndex]!};
  }));
  const comparisons=overlays.map(o=>{
    const selected=regions.filter(r=>{const x=r.polygon.reduce((n,p)=>n+p[0],0)/4,y=r.polygon.reduce((n,p)=>n+p[1],0)/4;return x>=o.box.x&&x<o.box.x+o.box.width&&y>=o.box.y&&y<o.box.y+o.box.height;});
    const actual=selected.map(r=>r.text).join(' ').trim(),expected=o.text;
    if(actual.length>4000)throw new ServiceError('mock_comparison_budget_exceeded');
    const normalize=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').replace(/(?<=[\p{Script=Han}]) (?=[\p{Script=Han}])/gu,'').trim();
    return {overlayId:o.id,expected,actual,matched:normalize(actual)===normalize(expected),regionIds:selected.map(r=>r.id),characterErrorRate:distance(normalize(expected),normalize(actual))/Math.max(1,normalize(expected).length)};
  });
  return MockValidationResultSchema.parse({schemaVersion:'mock-ocr.v1',synthetic:true,purpose:'mock_ocr_validation',ocrInputSha256:mockDigest(png),renderer:'canvas-overlay.v1',fontSha256,model:words.model,regions,comparisons,
    coverageGaps:[...(!regions.length?['ocr_no_text']:[]),...(comparisons.some(c=>!c.matched)?['synthetic_text_mismatch']:[]),...(clipped?['ocr_polygon_clipped']:[])],outsidePixelsUnchanged:true,originalFileUnchanged:true,originalPageUnchanged:true});
}
