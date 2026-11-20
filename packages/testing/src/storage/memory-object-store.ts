import { randomUUID } from 'node:crypto';
import type { ObjectStore, ObjectVersion } from '@hsbc/server/infrastructure/integrations/oss';
import { ServiceError } from '@hsbc/server/infrastructure/integrations/http';

export class MemoryObjectStore implements ObjectStore {
  objects=new Map<string,Map<string,Buffer>>();
  beforeRead?:()=>Promise<void>;
  beforePut?:()=>Promise<void>;
  async sign(key:string,_size:number,expiresAt:Date){return {host:'https://synthetic.invalid',fields:{key},expiresAt:expiresAt.toISOString()};}
  seed(key:string,bytes:Buffer){const id=randomUUID(),versions=this.objects.get(key)??new Map<string,Buffer>();versions.set(id,bytes);this.objects.set(key,versions);return id;}
  async put(key:string,bytes:Buffer,_type:'image/png'|'application/json'|'application/pdf'){if(this.beforePut){const hook=this.beforePut;this.beforePut=undefined;await hook();}const id=this.seed(key,bytes);return this.head(key,id);}
  async head(key:string,version?:string):Promise<ObjectVersion>{const versions=this.objects.get(key),id=version??[...(versions?.keys()??[])].at(-1),bytes=id&&versions?.get(id);if(!bytes)throw new ServiceError('oss_not_found');return {versionId:id!,size:bytes.length,lastModified:new Date()};}
  async read(key:string,version:string,maxBytes:number,range?:{start:number;end:number}){if(this.beforeRead){const hook=this.beforeRead;this.beforeRead=undefined;await hook();}const bytes=this.objects.get(key)?.get(version);if(!bytes)throw new ServiceError('oss_not_found');const result=range?bytes.subarray(range.start,range.end+1):bytes;if(result.length>maxBytes)throw new ServiceError('object_too_large');return result;}
  async versions(key:string){return Promise.all([...(this.objects.get(key)?.keys()??[])].map(id=>this.head(key,id)));}
  async deleteVersion(key:string,version:string){this.objects.get(key)?.delete(version);}
}
