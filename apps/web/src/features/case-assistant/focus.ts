import {useEffect, useSyncExternalStore} from 'react';

/** The file the reader is showing right now. The assistant offers it as the subject of a question;
 * the server re-reads the file with the sender's own access, so this is only a hint. */
export interface OpenDocument {caseId: string; documentId: string; filename: string}

let current: OpenDocument | undefined;
const listeners = new Set<() => void>();
const publish = (next: OpenDocument | undefined) => {current = next; for (const listener of listeners) listener();};
const subscribe = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};

export function useOpenDocument(caseId: string): OpenDocument | undefined {
  const value = useSyncExternalStore(subscribe, () => current);
  return value?.caseId === caseId ? value : undefined;
}
/** Called by the reader while a file is on screen; cleared when the reader leaves or switches file. */
export function useAnnounceOpenDocument(caseId: string, documentId: string, filename: string) {
  useEffect(() => {
    const mine = {caseId, documentId, filename};
    publish(mine);
    return () => {if (current === mine) publish(undefined);};
  }, [caseId, documentId, filename]);
}
