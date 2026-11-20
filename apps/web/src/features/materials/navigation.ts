export function materialReaderPath(caseId:string,documentId:string,roundId?:string|null) {
  const params=new URLSearchParams({mode:'reader',document:documentId});
  if(roundId)params.set('round',roundId);
  return `/cases/${encodeURIComponent(caseId)}/review?${params}`;
}
export function materialContentPath(caseId:string,documentId:string,download=false) {
  return `/api/cases/${encodeURIComponent(caseId)}/materials/${encodeURIComponent(documentId)}/content${download?'?download=1':''}`;
}
