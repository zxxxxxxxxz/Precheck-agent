/** Explicit operator-only OSS setup and synthetic acceptance; never imported by runtime. */
import OSS from 'ali-oss';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID,createHash } from 'node:crypto';
import { OssObjectStore,type UploadConfig } from '@hsbc/server/infrastructure/integrations/oss';
import { verifyPdf } from '@hsbc/server/modules/materials/uploads/pdf';
import { DOCUMENT_PAGE_LIMIT } from '@hsbc/contracts/document-limits';

const mode=process.argv.find(value=>value.startsWith('--mode='))?.slice(7);
if(!['inspect','configure','probe'].includes(mode??''))throw new Error('explicit_mode_required');
// Explicit temporary exception requested by the operator. Default acceptance
// continues to require a separate scoped identity and backup-read denial.
const useOperatorIdentity=process.argv.includes('--use-operator-identity');
if(useOperatorIdentity&&mode!=='probe')throw new Error('operator_identity_flag_requires_probe');
const reportPath=useOperatorIdentity?'docs/p1/oss-current-identity-validation.json':'docs/p1/oss-validation.json';
const source=parseEnv(await readFile('.env.remote','utf8'));
const accessKeyId=source.AccessKeyID,accessKeySecret=source.AccessKeySecret;
if(!accessKeyId||!accessKeySecret)throw new Error('operator_credential_missing');
const credential={accessKeyId,accessKeySecret};
const client=new OSS({region:'oss-cn-wulanchabu',bucket:'hsbc-poc',secure:true,timeout:30000,...credential});
const bucket='hsbc-poc';
const safeError=(e:unknown)=>({code:typeof e==='object'&&e!==null&&'code'in e?String(e.code):'operation_failed',status:typeof e==='object'&&e!==null&&'status'in e?Number(e.status):undefined});
await mkdir('docs/p1',{recursive:true});
try{
  const permissions:Record<string,unknown>={};
  const inspect=async(name:string,run:()=>Promise<any>)=>{try{const result=await run();permissions[name]='allowed';return result;}catch(error){permissions[name]=safeError(error);return null;}};
  const [versioning,cors,acl,info]=await Promise.all([
    inspect('GetBucketVersioning',()=> (client as any).getBucketVersioning(bucket)),
    inspect('GetBucketCORS',()=>client.getBucketCORS(bucket).catch((e:unknown)=>{if(safeError(e).code==='NoSuchCORSConfiguration')return{rules:[]};throw e;})),
    inspect('GetBucketACL',()=>client.getBucketACL(bucket)),inspect('GetBucketInfo',()=>client.getBucketInfo(bucket)),
  ]);
  const before={checkedAt:new Date().toISOString(),bucket,region:'cn-wulanchabu',versioning:versioning?.versionStatus??null,corsRules:cors?.rules??null,acl:acl?.acl??info?.bucket?.AccessControlList?.Grant??null,permissions};
  if(mode==='inspect'||mode==='configure'){
    // Preserve the first observed configuration. No AccessKey, signed fields or backup key names.
    try{await writeFile('docs/p1/oss-config-before.json',JSON.stringify(before,null,2)+'\n',{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  if(mode==='inspect'){console.log(JSON.stringify(before));}
  if(mode==='configure'){
    if(!versioning||!cors)throw new Error('bucket_configuration_read_permission_required');
    if(before.acl!=='private')throw new Error('existing_bucket_is_not_private');
    if(before.versioning!=='Enabled')await (client as any).putBucketVersioning(bucket,'Enabled');
    const origins=['https://hsbc.mse.pub','http://127.0.0.1:5174'];
    const prior=cors.rules??[];
    const requested={
      allowedOrigin:origins,allowedMethod:['POST'],allowedHeader:['content-type'],exposeHeader:['x-oss-version-id','etag','x-oss-request-id'],maxAgeSeconds:'300',
    };
    const next=prior.some((rule:any)=>JSON.stringify(rule)===JSON.stringify(requested))?prior:[...prior,requested];
    if(next.length>10)throw new Error('cors_rule_limit_requires_operator_review');
    await client.putBucketCORS(bucket,next);
    console.log(JSON.stringify({state:'configured',versioning:'Enabled',origins,existingCorsRulesPreserved:prior.length}));
  }
  if(mode==='probe'){
    if(before.acl!=='private')throw new Error('private_bucket_required');
    const runtimeAccessKeyId=useOperatorIdentity?accessKeyId:source.P1_OSS_ACCESS_KEY_ID,runtimeAccessKeySecret=useOperatorIdentity?accessKeySecret:source.P1_OSS_ACCESS_KEY_SECRET;
    if(!runtimeAccessKeyId||!runtimeAccessKeySecret)throw new Error('scoped_runtime_credential_missing');
    const runtimeCredential={accessKeyId:runtimeAccessKeyId,accessKeySecret:runtimeAccessKeySecret};
    if(!useOperatorIdentity&&runtimeCredential.accessKeyId===credential.accessKeyId)throw new Error('separate_runtime_credential_required');
    const runtimeClient=new OSS({region:'oss-cn-wulanchabu',bucket,secure:true,timeout:30000,authorizationV4:true,...runtimeCredential} as OSS.Options);
    let versionStatus=before.versioning;
    if(versionStatus!=='Enabled'){
      try{versionStatus=(await (runtimeClient as any).getBucketVersioning(bucket)).versionStatus;}catch{/* The human operator may instead confirm console configuration explicitly. */}
    }
    if(versionStatus&&versionStatus!=='Enabled')throw new Error('versioning_not_enabled');
    if(versionStatus!=='Enabled'&&!process.argv.includes('--confirm-console-configured'))throw new Error('versioning_requires_metadata_or_console_confirmation');
    const config:UploadConfig={enabled:true,bucket,region:'cn-wulanchabu',prefix:'p1/',maxBytes:52428800,maxPages:DOCUMENT_PAGE_LIMIT,ttlSeconds:300,orphanGraceSeconds:3600,credential:runtimeCredential};
    const store=new OssObjectStore(config),id=randomUUID(),key=`p1/verification/${id}/synthetic.pdf`;
    const bytes=await readFile('testdata/synthetic/01-native-unicode.pdf');
    const report:{checkedAt:string;scope:string;state:string;syntheticObjectKey:string;credentialSource:string;identityIsolation:string;error?:ReturnType<typeof safeError>;checks:Record<string,unknown>}={checkedAt:new Date().toISOString(),scope:'real_oss_synthetic_only',state:'running',syntheticObjectKey:key,credentialSource:useOperatorIdentity?'operator_identity_explicit_override':'separate_runtime_identity',identityIsolation:useOperatorIdentity?'deferred_by_user':'required',checks:{bucket_private:before.acl==='private',versioning:before.versioning}};
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    try{
      const signed=await store.sign(key,bytes.length,new Date(Date.now()+300000));
      const form=new FormData();for(const [name,value]of Object.entries(signed.fields))form.set(name,value);form.set('file',new Blob([bytes],{type:'application/pdf'}),'synthetic.pdf');
      const response=await fetch(signed.host,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Origin:'https://hsbc.mse.pub'}});
      if(response.status!==201){await response.body?.cancel();throw new Error(`post_object_http_${response.status}`);}
      await response.body?.cancel();const v1=response.headers.get('x-oss-version-id');
      if(!v1||v1==='null')throw new Error('post_object_version_missing');
      report.checks.post_object_v4=true;report.checks.versioning='Enabled_observed_non_null_version';
      report.checks.cors_origin=response.headers.get('access-control-allow-origin');
      if(report.checks.cors_origin!=='https://hsbc.mse.pub')throw new Error('cors_origin_mismatch');
      // Node fetch does not enforce browser CORS. Check exposed headers explicitly
      // so a passing CLI result also permits the browser to bind the actual version.
      const exposed=(response.headers.get('access-control-expose-headers')??'').toLowerCase().split(',').map(value=>value.trim());
      const required=['x-oss-version-id','etag','x-oss-request-id'];
      report.checks.cors_exposed_headers=required.every(name=>exposed.includes(name));
      report.checks.cors_missing_exposed_headers=required.filter(name=>!exposed.includes(name));
      const actual=await store.head(key,v1),download=await store.read(key,v1,config.maxBytes);const verified=await verifyPdf(download,config);
      if(!download.equals(bytes)||verified.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new Error('fixed_version_hash_mismatch');
      report.checks.fixed_version_read=true;report.checks.sha256=verified.sha256;report.checks.page_count=verified.pageCount;report.checks.size=actual.size;
      const range=await store.read(key,v1,5,{start:0,end:4});if(range.toString()!=='%PDF-')throw new Error('range_mismatch');report.checks.range=true;
      // A second object version on the same tracked key must not alter the pinned original.
      const replacement=await runtimeClient.put(key,Buffer.from('synthetic replacement, deliberately not a PDF'),{headers:{'Content-Type':'application/pdf'}});
      const v2=(replacement.res.headers as Record<string,unknown>)['x-oss-version-id'];if(typeof v2!=='string'||!v2||v2==='null'||v2===v1)throw new Error('version_overwrite_not_isolated');
      if(!(await store.read(key,v1,config.maxBytes)).equals(bytes))throw new Error('old_version_changed');report.checks.overwrite_preserves_original=true;
      if(useOperatorIdentity){
        report.checks.runtime_backup_read_denied='deferred_by_user_identity_reused';
        report.checks.existing_backup_readable='not_retested_no_backup_access';
      }else{
      const backups=await client.listV2({prefix:'backups/','max-keys':1});
      if(backups.objects?.[0]){
        const item=backups.objects[0];const stream=await client.getStream(item.name,{headers:{Range:'bytes=0-0'}});
        let size=0;for await(const chunk of stream.stream){size+=chunk.length;if(size>1){stream.stream.destroy();throw new Error('backup_range_unbounded');}}
        report.checks.existing_backup_readable=size===1;
        let denied=false;
        try{const attempt=await runtimeClient.getStream(item.name,{headers:{Range:'bytes=0-0'}});attempt.stream?.destroy();}
        catch(error){denied=safeError(error).status===403;}
        report.checks.runtime_backup_read_denied=denied;
        if(!denied)throw new Error('runtime_identity_can_read_backup');
      }else{report.checks.existing_backup_readable='no_backups_at_expected_prefix';throw new Error('backup_permission_isolation_not_verified');}
      }
      if(!report.checks.cors_exposed_headers)throw new Error('cors_exposed_headers_missing');
      report.state=useOperatorIdentity?'passed_with_identity_isolation_deferred':'passed';
    }catch(error){
      report.state='failed';report.error={...safeError(error),...(error instanceof Error&&/^[a-z_]+(_\d+)?$/.test(error.message)?{reason:error.message}:{})};throw error;
    }finally{
      // Key generated above in this invocation, only discovered concrete versions, never bucket-wide delete.
      try{
        const discovered=await store.versions(key);for(const object of discovered)await store.deleteVersion(key,object.versionId);
        report.checks.synthetic_versions_removed=discovered.length;report.checks.synthetic_cleanup_verified=(await store.versions(key)).length===0;
      }catch(error){report.state='failed';report.checks.cleanup_error=safeError(error);report.checks.synthetic_cleanup_verified=false;}
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
      if(report.checks.synthetic_cleanup_verified!==true)throw new Error('synthetic_cleanup_failed');
    }
    console.log(JSON.stringify(report));
  }
}catch(error){console.error(JSON.stringify({state:'failed',...safeError(error),...(error instanceof Error&&/^[a-z_]+(_\d+)?$/.test(error.message)?{reason:error.message}:{})}));process.exitCode=1;}
