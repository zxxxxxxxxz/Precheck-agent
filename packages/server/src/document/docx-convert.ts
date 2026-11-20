import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DocxBudgetsSchema, DocxConversionManifestSchema, type DocxBudgets, type DocxConversionManifest } from '@hsbc/contracts/docx';
import { verifyPdf } from '../modules/materials/uploads/pdf.js';
import { parseDocx } from './docx.js';
import { DocxError, docxHash } from './docx-zip.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema=z.strictObject({path:z.string().startsWith('/'),sha256:hash,size:z.number().int().nonnegative()});
export const DocxRuntimeManifestSchema=z.strictObject({
  schemaVersion:z.literal('docx-runtime.v1'),platform:z.literal('linux'),architecture:z.enum(['x64','arm64']),
  baseImage:z.string(),snapshot:z.string(),libreOfficeVersion:z.string(),
  packages:z.array(z.strictObject({name:z.string(),version:z.string()})),files:z.array(fileSchema).min(1).max(40000),
  fonts:z.array(z.strictObject({family:z.string(),file:z.string(),sha256:hash})).min(1),
  aliases:z.array(z.strictObject({requested:z.string(),resolved:z.string(),file:z.string(),sha256:hash})),
  fontManifestSha256:hash,
});
export type DocxRuntimeManifest=z.infer<typeof DocxRuntimeManifestSchema>;
export interface DocxRuntime { root:string; manifestSha256:string; bubblewrapPath:string; temporaryRoot?:string }
export interface DocxConversionOptions {
  signal?:AbortSignal;budgets?:Partial<DocxBudgets>;runtime?:DocxRuntime;
  mode?:'production'|'validation';
  /** Trusted test configuration only. Never set by request JSON or production environment. */
  isolatedReplay?:boolean;validationExecutable?:string;
}
export function loadDocxRuntime(env:NodeJS.ProcessEnv=process.env):DocxRuntime {
  const root=env.P2_DOCX_RUNTIME_ROOT,manifestSha256=env.P2_DOCX_RUNTIME_MANIFEST_SHA256;
  if(!root||!isAbsolute(root)||!manifestSha256||!hash.safeParse(manifestSha256).success)throw new DocxError('docx_runtime_unconfigured');
  const bubblewrapPath=env.P2_DOCX_BWRAP_PATH??'/usr/bin/bwrap';if(!isAbsolute(bubblewrapPath))throw new DocxError('docx_runtime_invalid');
  return {root,manifestSha256,bubblewrapPath,temporaryRoot:env.P2_DOCX_TEMP_ROOT};
}
const environment=(home:string):NodeJS.ProcessEnv=>({PATH:'/usr/bin:/bin',HOME:home,TMPDIR:home,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',SAL_USE_VCLPLUGIN:'svp'});
const aborted=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DocxError('docx_conversion_cancelled');};
let active=false;
const waiters:Array<()=>void>=[];
async function acquire(signal?:AbortSignal){
  aborted(signal);
  if(active)await new Promise<void>((yes,no)=>{
    const ready=()=>{signal?.removeEventListener('abort',cancel);yes();};
    const cancel=()=>{const i=waiters.indexOf(ready);if(i>=0)waiters.splice(i,1);no(new DocxError('docx_conversion_cancelled'));};
    waiters.push(ready);signal?.addEventListener('abort',cancel,{once:true});
  });
  active=true;
  return ()=>{const next=waiters.shift();if(next)next();else active=false;};
}
async function directoryBytes(path:string):Promise<number>{
  let bytes=0,files=0;const walk=async(p:string):Promise<void>=>{const names=await readdir(p).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});for(const name of names){if(++files>4096)throw new DocxError('docx_temporary_budget');const child=join(p,name),s=await lstat(child).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});if(!s)continue;if(s.isDirectory())await walk(child);else bytes+=s.size;}};await walk(path);return bytes;
}
/** Spawn only an explicit executable. Child output is never forwarded or attached to errors. */
async function run(executable:string,args:string[],opts:{cwd:string;signal?:AbortSignal;timeout:number;capture?:boolean;budget?:number}):Promise<string>{
  aborted(opts.signal);
  return new Promise((yes,no)=>{
    let error:DocxError|undefined,out='',settled=false,checking=false;
    const child=spawn(executable,args,{cwd:opts.cwd,env:environment(opts.cwd),stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    const kill=(code:string)=>{error??=new DocxError(code);try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* Exit races are expected. */}};
    const cancel=()=>kill('docx_conversion_cancelled'),timeout=setTimeout(()=>kill('docx_conversion_timeout'),opts.timeout);
    const watch=opts.budget?setInterval(()=>{if(checking)return;checking=true;void directoryBytes(opts.cwd).then(size=>{if(size>opts.budget!)kill('docx_temporary_budget');},()=>kill('docx_output_invalid')).finally(()=>{checking=false;});},100):undefined;
    opts.signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.on('data',(chunk:Buffer)=>{if(opts.capture){out+=chunk.toString('utf8');if(Buffer.byteLength(out)>65536)kill('docx_process_output_budget');}});child.stderr.resume();
    const finish=(err?:DocxError)=>{if(settled)return;settled=true;clearTimeout(timeout);if(watch)clearInterval(watch);opts.signal?.removeEventListener('abort',cancel);err?no(err):yes(out);};
    child.once('error',()=>finish(new DocxError('docx_converter_unavailable')));
    child.once('close',code=>finish(error??(code===0?undefined:new DocxError('docx_conversion_failed'))));
    if(opts.signal?.aborted)cancel();
  });
}
/** No host /app, secrets, sockets, environment, network, or PID namespace is shared. */
export function docxSandboxArgs(runtime:DocxRuntime,job:string,command:string[]):string[]{
  return ['--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--die-with-parent','--new-session','--cap-drop','ALL',
    '--ro-bind',join(runtime.root,'rootfs'),'/', '--dev','/dev',
    '--bind',join(job,'work'),'/work','--bind',join(job,'work'),'/tmp','--ro-bind',join(job,'input'),'/input','--bind',join(job,'out'),'/out',
    '--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/work','--setenv','TMPDIR','/work','--setenv','LANG','C.UTF-8','--setenv','LC_ALL','C.UTF-8','--setenv','SAL_USE_VCLPLUGIN','svp','--chdir','/work','--',...command];
}
async function fileHash(path:string){const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);return h.digest('hex');}
const verified=new Map<string,Promise<DocxRuntimeManifest>>();
async function runtimeManifest(runtime:DocxRuntime):Promise<DocxRuntimeManifest>{
  const key=`${runtime.root}:${runtime.manifestSha256}:${runtime.bubblewrapPath}`;
  let pending=verified.get(key);if(!pending){pending=(async()=>{
    if(process.platform!=='linux')throw new DocxError('docx_sandbox_requires_linux');
    const raw=await readFile(join(runtime.root,'manifest.json'));if(raw.length>16*1024*1024||docxHash(raw)!==runtime.manifestSha256)throw new DocxError('docx_runtime_manifest_mismatch');
    let m:DocxRuntimeManifest;try{m=DocxRuntimeManifestSchema.parse(JSON.parse(raw.toString('utf8')));}catch{throw new DocxError('docx_runtime_manifest_invalid');}
    if(m.architecture!==process.arch)throw new DocxError('docx_runtime_architecture_mismatch');
    const root=await realpath(join(runtime.root,'rootfs')),seen=new Set<string>();let total=0;
    for(const f of m.files){
      const path=resolve(root,'.'+f.path);if(!path.startsWith(root+sep)||seen.has(path))throw new DocxError('docx_runtime_manifest_invalid');seen.add(path);
      const actual=await realpath(path);if(!actual.startsWith(root+sep))throw new DocxError('docx_runtime_path_invalid');
      const s=await lstat(path);total+=s.size;if(!s.isFile()||s.size!==f.size||total>3*1024**3||await fileHash(path)!==f.sha256)throw new DocxError('docx_runtime_file_mismatch');
    }
    if(!m.files.some(f=>f.path==='/usr/lib/libreoffice/program/soffice.bin')||!m.files.some(f=>f.path==='/opt/p2-docx/run-converter.py')||!m.files.some(f=>f.path==='/opt/p2-docx/probe.py'))throw new DocxError('docx_runtime_manifest_incomplete');
    for(const f of [...m.fonts,...m.aliases])if(!m.files.some(x=>x.path===f.file&&x.sha256===f.sha256))throw new DocxError('docx_runtime_font_mismatch');
    if(docxHash(JSON.stringify({fonts:m.fonts,aliases:m.aliases}))!==m.fontManifestSha256)throw new DocxError('docx_runtime_font_mismatch');
    return m;
  })().catch(error=>{verified.delete(key);throw error instanceof DocxError?error:new DocxError('docx_runtime_unavailable');});verified.set(key,pending);}return pending;
}
async function prepareJob(root:string){const job=await mkdtemp(join(root,'p2-docx-'));for(const part of ['input','out','work'])await mkdir(join(job,part),{mode:0o700});return job;}
async function probe(runtime:DocxRuntime,job:string,signal?:AbortSignal){
  const result=await run(runtime.bubblewrapPath,docxSandboxArgs(runtime,job,['/usr/bin/python3','/opt/p2-docx/probe.py']),{cwd:job,signal,timeout:15000,capture:true});
  if(result.trim()!=='docx-sandbox-probe-v1:ok')throw new DocxError('docx_sandbox_probe_failed');
}
export async function probeDocxRuntime(runtime:DocxRuntime=loadDocxRuntime(),signal?:AbortSignal){
  const release=await acquire(signal);let job:string|undefined;
  try{const manifest=await runtimeManifest(runtime);job=await prepareJob(runtime.temporaryRoot??tmpdir());await probe(runtime,job,signal);return {ok:true as const,runtimeManifestSha256:runtime.manifestSha256,fontManifestSha256:manifest.fontManifestSha256,libreOfficeVersion:manifest.libreOfficeVersion};}
  finally{if(job)await rm(job,{recursive:true,force:true});release();}
}
export async function convertDocx(bytes:Uint8Array,options:DocxConversionOptions={}):Promise<{pdf:Buffer;manifest:DocxConversionManifest}>{
  const b=DocxBudgetsSchema.parse(options.budgets??{}),mode=options.mode??'production';
  if(mode==='validation'&&(!options.isolatedReplay||!options.validationExecutable||!isAbsolute(options.validationExecutable)))throw new DocxError('docx_validation_not_authorized');
  if(mode==='production'&&(options.isolatedReplay||options.validationExecutable))throw new DocxError('docx_production_bypass_forbidden');
  const source=await parseDocx(bytes,b),release=await acquire(options.signal),started=Date.now();let job:string|undefined;
  try{
    const runtime=mode==='production'?(options.runtime??loadDocxRuntime()):undefined,m=runtime?await runtimeManifest(runtime):undefined;
    const tempRoot=runtime?.temporaryRoot??tmpdir();
    if(runtime){const fs=await statfs(tempRoot);if(fs.type!==0x01021994||fs.bsize*fs.blocks>b.maxTemporaryBytes)throw new DocxError('docx_temporary_volume_unbounded');}
    job=await prepareJob(tempRoot);await writeFile(join(job,'input','input.docx'),bytes,{mode:0o600});
    let version:string;
    // The production tmpfs is a hard quota. Do not recursively traverse files while
    // the untrusted converter can race directory/symlink replacements.
    if(runtime){await probe(runtime,job,options.signal);version=m!.libreOfficeVersion;await run(runtime.bubblewrapPath,docxSandboxArgs(runtime,job,['/usr/bin/python3','/opt/p2-docx/run-converter.py',String(b.maxOutputPdfBytes),String(Math.ceil(b.conversionTimeoutMs/1000))]),{cwd:job,signal:options.signal,timeout:b.conversionTimeoutMs});}
    else{
      const output=await run(options.validationExecutable!,['--version'],{cwd:job,signal:options.signal,timeout:10000,capture:true});
      // Native replay also runs against the bundled development build. Preserve
      // its real version; this branch never makes a runtime production eligible.
      const matched=/^(?:LibreOffice [0-9]+(?:\.[0-9]+){1,4}|LibreOfficeDev [0-9]+(?:\.[0-9]+){1,4}\.(?:alpha|beta|rc)[0-9]+)(?: (?:[a-f0-9]+|[0-9]+\(Build:[0-9]+\)))?\s*$/u.exec(output.trim());if(!matched)throw new DocxError('docx_converter_version_invalid');version=output.trim();
      await run(options.validationExecutable!,['--headless','--nologo','--nodefault','--norestore','--nolockcheck',`-env:UserInstallation=${pathToFileURL(join(job,'work','profile')).href}`,'--convert-to','pdf:writer_pdf_Export','--outdir',join(job,'out'),join(job,'input','input.docx')],{cwd:job,signal:options.signal,timeout:b.conversionTimeoutMs,budget:b.maxTemporaryBytes});
    }
    aborted(options.signal);const output=join(job,'out','input.pdf'),stat=await lstat(output).catch(()=>{throw new DocxError('docx_output_missing');});
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>b.maxOutputPdfBytes||!runtime&&await directoryBytes(job)>b.maxTemporaryBytes)throw new DocxError('docx_output_budget');
    const pdf=await readFile(output);let pageCount:number;try{pageCount=(await verifyPdf(pdf,{maxBytes:b.maxOutputPdfBytes,maxPages:b.maxPreviewPages})).pageCount;}catch{throw new DocxError('docx_output_pdf_invalid');}
    const fonts=source.fonts.map(font=>{const alias=m?.aliases.find(a=>a.requested.toLowerCase()===font.name.toLowerCase());return {requested:font.name,resolved:alias?.resolved??null,status:!alias?'unresolved' as const:alias.resolved.split(',').some(name=>name.trim().toLowerCase()===font.name.toLowerCase())?'available' as const:'substituted' as const,basis:'runtime_manifest' as const,runtimeFontPath:alias?.file??null,fileSha256:alias?.sha256??null};});
    const gaps=new Set(['preview_fidelity_requires_verification','source_to_preview_mapping_not_established',...source.coverageGaps]);
    if(mode==='validation')gaps.add('validation_only_unsandboxed_runtime');
    if(mode==='validation'&&version.startsWith('LibreOfficeDev '))gaps.add('development_converter_not_release_validated');
    if(fonts.some(f=>f.status!=='available'))gaps.add('font_substitution_or_coverage_unverified');
    const manifest=DocxConversionManifestSchema.parse({schemaVersion:'docx-conversion.v1',sourceSha256:source.sourceSha256,pdfSha256:docxHash(pdf),pdfBytes:pdf.length,pageCount,converter:{name:'LibreOffice',version,runtimeManifestSha256:runtime?.manifestSha256??null},mode,sandboxed:mode==='production',productionEligible:mode==='production',fontManifestSha256:m?.fontManifestSha256??null,configurationSha256:docxHash(JSON.stringify({budgets:b,mode,runtime:runtime?.manifestSha256??null,profile:'docx-safe-v1'})),fonts,coverageGaps:[...gaps].sort(),elapsedMs:Date.now()-started});
    return {pdf,manifest};
  }finally{try{if(job)await rm(job,{recursive:true,force:true});}finally{release();}}
}
