/** Provision a named isolated instance for closed-loop acceptance over HTTP only:
 * administrator password, a Maker, an independent Checker and a rule approver,
 * the fixed review team, and published review configurations.
 * Re-running continues from the private access file; nothing secret is printed.
 *
 *   P1_NATIVE_INSTANCE=<name> scripts/node24.sh --import tsx scripts/closed-loop-provision.ts --manifest=<path.json> [--manifest=...] */
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {HttpFailure,LoopClient,loopTarget,readPrivateJson} from './closed-loop-client.js';

interface Identity {username:string;password:string;personId?:string;accountId?:string}
interface Access {origin:string;admin?:Identity;maker?:Identity;checker?:Identity;approver?:Identity;releases:string[]}
const ACCESS_FILE='closed-loop-access.json';
const target=loopTarget(),file=join(target.directory,ACCESS_FILE);
const manifests=process.argv.slice(2).map(arg=>/^--manifest=(.+)$/.exec(arg)?.[1]).filter((value):value is string=>!!value);
if(process.argv.slice(2).some(arg=>!arg.startsWith('--manifest=')))throw new Error('Usage: closed-loop-provision.ts --manifest=<path.json> [--manifest=...]');
const access:Access=existsSync(file)?readPrivateJson<Access>(target.directory,ACCESS_FILE):{origin:target.web,releases:[]};
if(access.origin!==target.web)throw new Error('access_file_instance_mismatch');
const save=()=>{writeFileSync(file,JSON.stringify(access,null,2)+'\n',{mode:0o600});chmodSync(file,0o600);};
const newPassword=()=>`Lp${randomBytes(21).toString('base64url')}!7a`;
const step=(name:string,state:string)=>console.log(JSON.stringify({step:name,state}));
const reason='闭环验收环境开通';

/** First sign-in with a temporary password, then the mandatory change. */
async function activate(username:string,temporary:string):Promise<Identity>{
  const client=new LoopClient(target),user=await client.login(username,temporary),password=newPassword();
  await client.changePassword(temporary,password);
  return {username,password,personId:user.personId,accountId:user.accountId};
}

if(!access.admin){
  const bootstrap=readPrivateJson<{username:string;temporaryPassword:string}>(target.directory,'bootstrap-admin.json');
  access.admin=await activate(bootstrap.username,bootstrap.temporaryPassword);save();step('administrator','activated');
}else step('administrator','present');
const admin=new LoopClient(target);await admin.login(access.admin.username,access.admin.password);

for(const [role,username,displayName] of [['maker','loop.maker','闭环经办'],['checker','loop.checker','闭环复核'],['approver','loop.approver','闭环规则审批']] as const){
  if(access[role]){step(role,'present');continue;}
  const created=await admin.request<{temporaryPassword:string}>('/api/admin/accounts',{username,displayName,businessRole:'BCO',reason});
  access[role]=await activate(username,created.temporaryPassword);save();step(role,'activated');
}
const maker=access.maker!,checker=access.checker!,approver=access.approver!;

const teams=await admin.request<{items:Array<{makerPersonId:string;checkerPersonId:string;enabled:boolean;version:number}>}>('/api/admin/review-teams');
const team=teams.items.find(item=>item.makerPersonId===maker.personId);
if(team?.enabled&&team.checkerPersonId===checker.personId)step('review-team','present');
else{
  await admin.request('/api/admin/review-teams',{makerPersonId:maker.personId,checkerPersonId:checker.personId,enabled:true,expectedVersion:team?.version??0,reason});
  step('review-team','configured');
}
for(const [identity,actions] of [[maker,['rule:read','rule:propose','rule:trial']],[approver,['rule:read','rule:approve','rule:publish']]] as const)
  for(const action of actions)await admin.request('/api/admin/access-grants',{personId:identity.personId,action,reason});
step('rule-grants','granted');

if(manifests.length){
  const author=new LoopClient(target),reviewer=new LoopClient(target);
  await author.login(maker.username,maker.password);await reviewer.login(approver.username,approver.password);
  for(const path of manifests){
    const manifest=JSON.parse(readFileSync(resolve(path),'utf8')) as {releaseId:string;scope:string};
    if(manifest.scope!=='synthetic')throw new Error('synthetic_configuration_required');
    const list=await author.request<{items:Array<{id:string;status:string;revision:number;manifest:{releaseId:string}}>}>('/api/review-configs');
    let draft=list.items.find(item=>item.manifest.releaseId===manifest.releaseId);
    if(draft?.status==='published'){if(!access.releases.includes(manifest.releaseId)){access.releases.push(manifest.releaseId);save();}step(`configuration:${manifest.releaseId}`,'present');continue;}
    const read=(id:string)=>author.request<{id:string;status:string;revision:number;manifest:{releaseId:string};validation:{valid:boolean}}>(`/api/review-configs/${id}`);
    const command=(revision:number)=>({expectedRevision:revision,idempotencyKey:randomUUID()});
    try{
      if(!draft)draft=await author.request('/api/review-configs',{manifest,idempotencyKey:randomUUID()},{timeoutMs:120000});
      let current=await read(draft!.id);
      if(!['trial_passed','approved'].includes(current.status)){await author.request(`/api/review-configs/${current.id}/trial`,command(current.revision),{timeoutMs:180000});current=await read(current.id);}
      if(current.status==='trial_passed'){await reviewer.request(`/api/review-configs/${current.id}/approve`,command(current.revision),{timeoutMs:120000});current=await read(current.id);}
      if(current.status==='approved'){await reviewer.request(`/api/review-configs/${current.id}/publish`,command(current.revision),{timeoutMs:180000});current=await read(current.id);}
      if(current.status!=='published')throw new Error(`configuration_not_published:${current.status}`);
      access.releases.push(manifest.releaseId);save();step(`configuration:${manifest.releaseId}`,'published');
    }catch(error){
      step(`configuration:${manifest.releaseId}`,error instanceof HttpFailure?`failed:${error.route}:${error.status}:${error.code}`:`failed:${(error as Error).message}`);
      process.exitCode=1;
    }
  }
}
console.log(JSON.stringify({code:'closed_loop_provisioned',instance:target.instance,web:target.web,accessFile:`<instance dir>/${ACCESS_FILE}`,releases:access.releases}));
