import {createCanvas,loadImage} from '@napi-rs/canvas';
import {DRAFT_ATTACHMENT_LIMITS as limits} from '@hsbc/contracts/draft-attachment';
import {ServiceError} from '../infrastructure/integrations/http.js';
import type {NativePdfPage} from './pdf.js';
import {sha256} from './evidence.js';

/** Inspect dimensions before native decoding can allocate memory. Only still JPEG/PNG are accepted. */
export function imageDimensions(input:Uint8Array,mimeType:string){
  const bytes=Buffer.from(input);let width=0,height=0;
  if(!bytes.length||bytes.length>limits.imageBytes)throw new ServiceError('upload_image_size_exceeded');
  if(mimeType==='image/png'){
    if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(12,16).toString()!=='IHDR'||bytes.readUInt32BE(8)!==13)throw new ServiceError('upload_invalid_image');
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);let ended=false;
    for(let offset=8;offset+12<=bytes.length;){
      const length=bytes.readUInt32BE(offset),end=offset+12+length;
      if(end>bytes.length)throw new ServiceError('upload_invalid_image');
      const kind=bytes.subarray(offset+4,offset+8).toString();
      if(kind==='acTL'||kind==='fcTL'||kind==='fdAT')throw new ServiceError('upload_animated_image_unsupported');
      if(kind==='IEND'){if(length!==0||end!==bytes.length)throw new ServiceError('upload_invalid_image');ended=true;break;}
      offset=end;
    }
    if(!ended)throw new ServiceError('upload_invalid_image');
  }else if(mimeType==='image/jpeg'){
    if(bytes.length<4||bytes.readUInt16BE(0)!==0xffd8)throw new ServiceError('upload_invalid_image');
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==0xff)throw new ServiceError('upload_invalid_image');
      while(bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];if(marker===0xda||marker===0xd9)break;
      if(marker===0x01||marker!==undefined&&marker>=0xd0&&marker<=0xd7)continue;
      if(offset+2>bytes.length)throw new ServiceError('upload_invalid_image');
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)throw new ServiceError('upload_invalid_image');
      if(marker!==undefined&&[0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(length<8)throw new ServiceError('upload_invalid_image');height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;
      }
      offset+=length;
    }
  }else throw new ServiceError('upload_image_type_unsupported');
  if(!width||!height||width>limits.imageSide||height>limits.imageSide||width*height>limits.imagePixels)throw new ServiceError('upload_image_pixel_budget');
  return {width,height};
}


/** Called inside the bounded page worker. The original remains the evidence identity. */
export async function renderImagePage(bytes:Uint8Array,format:'png'|'jpg',identity:{documentVersionId:string;parseRevision:string},maxPixels:number){
  imageDimensions(bytes,format==='png'?'image/png':'image/jpeg');
  const image=await loadImage(Buffer.from(bytes));
  if(!image.width||!image.height||image.width>limits.imageSide||image.height>limits.imageSide||image.width*image.height>limits.imagePixels)throw new Error('p2_page_pixel_budget_exceeded');
  const scale=Math.min(1,Math.sqrt(maxPixels/(image.width*image.height)));
  const width=Math.max(1,Math.floor(image.width*scale)),height=Math.max(1,Math.floor(image.height*scale));
  if(width*height>maxPixels)throw new Error('p2_page_pixel_budget_exceeded');
  const canvas=createCanvas(width,height),context=canvas.getContext('2d');
  context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0,width,height);
  const native:NativePdfPage={page:{schema_version:'p0.v1',page_asset_id:`${identity.documentVersionId}:${identity.parseRevision}:p1:image`,
    document_version_id:identity.documentVersionId,parse_revision:identity.parseRevision,page_number:1,printed_page_label:null,
    width,height,source_sha256:sha256(bytes),renderer:'image-canvas-v1',renderer_config:`image-v1:${format}:${width}x${height}`,
    // Legacy PageAsset coordinate slots describe the decoded, orientation-normalized raster.
    pdf_view_box:[0,0,image.width,image.height],intrinsic_rotation:0,pdf_to_page:[width/image.width,0,0,height/image.height,0,0]},
    regions:[],source_items:[],image_occurrences:1,text_layer_trust:'requires_validation',coverage_gaps:[]};
  return {native,png:canvas.toBuffer('image/png'),downscaled:scale<1};
}
