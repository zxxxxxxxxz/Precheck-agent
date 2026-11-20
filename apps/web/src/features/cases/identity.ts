type CaseIdentity = {id: string; title: string; caseNumber?: string | null; reference?: string | null};

export function caseIdentifier(item: CaseIdentity) {
  return item.caseNumber || item.reference || item.id;
}

export function caseDisplayName(item: CaseIdentity) {
  return item.title.trim() || caseIdentifier(item);
}
