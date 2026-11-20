import {AppError} from '../shared/errors.js';

// The compatibility bridge pins this value to true in its own immutable build.
// Runtime environment variables cannot reopen a read-only rollback artifact.
export const RELEASE_READ_ONLY=false;
export function assertReleaseWrite(method:string,url:string,readOnly=RELEASE_READ_ONLY){
  if(!readOnly||['GET','HEAD','OPTIONS'].includes(method))return;
  const path=url.split('?',1)[0];
  if(method==='POST'&&['/api/auth/login','/api/auth/logout','/api/auth/session/activity'].includes(path!))return;
  throw new AppError(503,'release_read_only');
}
