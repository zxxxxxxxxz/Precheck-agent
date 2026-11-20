
export function logEvent(code:string, fields:Record<string,unknown>={}) {
  const keys=new Set(['requestId','workId','caseId','state','count','durationMs','port']);
  console.log(JSON.stringify({code,...Object.fromEntries(Object.entries(fields).filter(([k,v])=>keys.has(k)&&['string','number','boolean'].includes(typeof v)))}));
}
