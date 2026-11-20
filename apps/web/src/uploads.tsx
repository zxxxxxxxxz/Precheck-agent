import React, {createContext, useContext, useEffect, useState, useSyncExternalStore} from 'react';
import {api, newKey} from './api.ts';
import {uploadToOss} from './upload.ts';
import {MaterialUploadQueue} from './features/materials/upload-queue.ts';
export {terminalUpload, type UploadState} from './features/materials/upload-queue.ts';

const UploadContext = createContext<MaterialUploadQueue | null>(null);
/** Transfers survive case-tab navigation and stop when the authenticated shell unmounts. */
export function UploadProvider({children}: {children: React.ReactNode}) {
  const [queue] = useState(() => new MaterialUploadQueue({request: api, transfer: uploadToOss, key: newKey}));
  useEffect(() => () => queue.dispose(), [queue]);
  return <UploadContext.Provider value={queue}>{children}</UploadContext.Provider>;
}
export function useUploads() {
  const queue = useContext(UploadContext);
  if (!queue) throw new Error('UploadProvider missing');
  const states = useSyncExternalStore(queue.subscribe, queue.snapshot);
  return {states, start: queue.start, cancel: queue.cancel, completeAgain: queue.completeAgain, dismiss: queue.dismiss, settle: queue.settle};
}
