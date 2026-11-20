/** HTTP client shared by the closed-loop provisioning and run scripts.
 * It talks only to a named isolated local instance and never prints bodies,
 * cookies, CSRF values, signed upload fields or credentials. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {getP1Paths, loadP1Environment} from '../infra/dev/p1-native.mjs';

export interface LoopTarget {instance:string; directory:string; web:string; api:string}
export class HttpFailure extends Error {
  constructor(readonly status:number, readonly code:string, readonly requestId:string|null, readonly route:string){super(`http_${status}:${code}`);}
}
const loopback=/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/;

/** The loop refuses the default instance and anything that is not loopback. */
export function loopTarget(env:NodeJS.ProcessEnv=process.env):LoopTarget {
  const instance=env.P1_NATIVE_INSTANCE;
  if(!instance)throw new Error('named_isolated_instance_required');
  const loaded=loadP1Environment() as Record<string,string>,api=`http://127.0.0.1:${loaded.P1_PORT}`;
  if(loaded.P1_MODE!=='local'||loaded.P1_NATIVE_INSTANCE!==instance||!loopback.test(loaded.P1_ORIGIN??'')||!loopback.test(api)||api===loaded.P1_ORIGIN)throw new Error('loop_target_mismatch');
  return {instance,directory:getP1Paths(instance).localDir as string,web:loaded.P1_ORIGIN!,api};
}

/** Route templates keep identifiers out of step logs. */
export const routeTemplate=(path:string)=>path.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,':id');

export interface Call {method:string; route:string; status:number; code:string|null; requestId:string|null; ms:number}
export class LoopClient {
  private csrf='';
  private readonly cookies=new Map<string,string>();
  constructor(readonly target:LoopTarget, private readonly observe:(call:Call)=>void=()=>{}){}
  async request<T=any>(path:string, body?:unknown, options:{method?:'GET'|'POST'|'PUT'; timeoutMs?:number}={}):Promise<T>{
    const method=options.method??(body===undefined?'GET':'POST'),started=Date.now(),route=routeTemplate(path);
    let response:Response;
    try{
      response=await fetch(this.target.api+path,{method,redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??60000),
        headers:{origin:this.target.web,cookie:[...this.cookies.values()].join('; '),'x-csrf-token':this.csrf,...(body===undefined?{}:{'content-type':'application/json'})},
        body:body===undefined?undefined:JSON.stringify(body)});
    }catch{
      this.observe({method,route,status:0,code:'transport_failed',requestId:null,ms:Date.now()-started});
      throw new HttpFailure(0,'transport_failed',null,route);
    }
    for(const header of response.headers.getSetCookie()){const pair=header.split(';')[0]!;this.cookies.set(pair.slice(0,pair.indexOf('=')),pair);}
    let parsed:any=null;
    try{parsed=await response.json();}catch{/* Non-JSON bodies are never interpreted or logged. */}
    const code=response.ok?null:String(parsed?.error?.code??parsed?.code??'request_failed'),requestId=parsed?.error?.requestId??null;
    this.observe({method,route,status:response.status,code,requestId,ms:Date.now()-started});
    if(!response.ok)throw new HttpFailure(response.status,code!,requestId,route);
    return parsed as T;
  }
  /** One login per role per process: sign-in is rate limited per address. */
  async login(username:string,password:string){
    this.csrf=(await this.request<{csrf:string}>('/api/auth/session')).csrf;
    const session=await this.request<{csrf:string;user:{personId:string;accountId:string;mustChangePassword:boolean}}>('/api/auth/login',{username,password});
    this.csrf=session.csrf;return session.user;
  }
  async changePassword(currentPassword:string,newPassword:string){
    await this.request('/api/auth/password/change',{currentPassword,newPassword});
    this.cookies.clear();this.csrf='';
  }
}

export const readPrivateJson=<T>(directory:string,name:string):T=>JSON.parse(readFileSync(join(directory,name),'utf8')) as T;
export const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
