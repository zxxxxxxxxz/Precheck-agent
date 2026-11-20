import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {ServiceError} from '../../../infrastructure/integrations/http.js';

export {imageDimensions} from '../../../document/image.js';
import {imageDimensions} from '../../../document/image.js';

async function decodeImage(bytes:Uint8Array,mimeType:string,render:boolean,signal?:AbortSignal):Promise<Buffer|undefined>{
  const dimensions=imageDimensions(bytes,mimeType);signal?.throwIfAborted();
  const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    const {createCanvas,loadImage}=require(workerData.library);
    (async()=>{try{const image=await loadImage(Buffer.from(workerData.bytes));
      if(image.width*image.height>16000000||image.width>10000||image.height>10000||image.width<=0||image.height<=0)throw Error();
      if(!workerData.render){parentPort.postMessage({ok:true});return;}
      const scale=Math.min(1,Math.sqrt(10000000/(image.width*image.height)));
      const canvas=createCanvas(Math.max(1,Math.floor(image.width*scale)),Math.max(1,Math.floor(image.height*scale)));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const png=canvas.toBuffer('image/png');if(png.length>10485760){parentPort.postMessage({error:'attachment_ocr_image_budget'});return;}
      parentPort.postMessage({ok:true,png});
    }catch{parentPort.postMessage({error:'upload_invalid_image'});}})();`,{eval:true,stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32},workerData:{bytes:new Uint8Array(bytes),dimensions,render,library:createRequire(import.meta.url).resolve('@napi-rs/canvas')}});
  worker.stdout.resume();worker.stderr.resume();
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=(error?:Error,png?:Uint8Array)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(png?Buffer.from(png):undefined);};
    const abort=()=>finish(new ServiceError('attachment_canceled'));const timer=setTimeout(()=>finish(new ServiceError('upload_image_timeout')),30000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.once('message',(result:{ok?:boolean;error?:string;png?:Uint8Array})=>finish(result.ok?undefined:new ServiceError(result.error??'upload_invalid_image'),result.png));
    worker.once('error',()=>finish(new ServiceError('upload_invalid_image')));worker.once('exit',()=>{if(!settled)finish(new ServiceError('upload_invalid_image'));});
  });
}
export async function verifyImage(bytes:Uint8Array,mimeType:string){await decodeImage(bytes,mimeType,false);return {sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,pageCount:1};}
export async function imageForOcr(bytes:Uint8Array,mimeType:string,signal?:AbortSignal){return (await decodeImage(bytes,mimeType,true,signal))!;}
