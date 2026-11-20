import {DraftSourceSchema, type DraftSource} from '@hsbc/contracts/draft';
import type {CaseSummary} from '../cases/types.ts';
import type {SystemCapabilities} from '../../capabilities.ts';
import type {UploadSession, UploadTicket} from './types.ts';
import {materialMime, validateMaterial} from '../../upload.ts';

export interface UploadState {
  roundId?:string|null;id: string; caseId: string; filename: string; progress: number;
  queued: boolean; transmitting: boolean; canceled?: boolean; actionPending?: boolean;
  upload?: UploadSession; error?: unknown; localError?: string;
}
export const terminalUpload = (state?: string) => !!state && ['registered', 'rejected', 'expired', 'canceled'].includes(state);
interface Dependencies {
  request: <T>(path: string, options?: {method?: 'GET' | 'POST' | 'PUT'; body?: unknown; signal?: AbortSignal}) => Promise<T>;
  transfer: (ticket: UploadTicket, file: File, progress: (percent: number) => void, signal: AbortSignal) => Promise<{versionId?: string; requestId?: string}>;
  key: () => string;
}
interface Transfer {item: CaseSummary; file: File; source: DraftSource; controller: AbortController}

/** Each selection appends independent transfers, including files with identical names. */
export class MaterialUploadQueue {
  private states: UploadState[] = [];
  private listeners = new Set<() => void>();
  private transfers = new Map<string, Transfer>();
  private pending: string[] = [];
  private active = 0;
  private disposed = false;
  constructor(private dependencies: Dependencies, private concurrency = 3) {}
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  snapshot = () => this.states;
  private publish(states: UploadState[]) {this.states = states; for (const listener of this.listeners) listener();}
  private patch(id: string, patch: Partial<UploadState>) {
    if (!this.disposed) this.publish(this.states.map(state => state.id === id ? {...state, ...patch} : state));
  }
  private state(id: string) {return this.states.find(state => state.id === id);}
  start = (item: CaseSummary, files: File[], source: DraftSource) => {
    if (this.disposed) return;
    const additions = files.map(file => {
      const id = this.dependencies.key();
      this.transfers.set(id, {item, file, source: {...source}, controller: new AbortController()});
      this.pending.push(id);
      return {roundId:item.selectedRoundId??null,id, caseId: item.id, filename: file.name, progress: 0, queued: true, transmitting: false};
    });
    this.publish([...this.states, ...additions]);
    this.pump();
  };
  private pump() {
    while (!this.disposed && this.active < this.concurrency && this.pending.length) {
      const id = this.pending.shift()!, transfer = this.transfers.get(id);
      if (!transfer || transfer.controller.signal.aborted) continue;
      this.active++;
      void this.run(id, transfer).finally(() => {this.transfers.delete(id); this.active--; this.pump();});
    }
  }
  private async run(id: string, {item, file, source, controller}: Transfer) {
    const {signal} = controller;
    this.patch(id, {queued: false, transmitting: true});
    try {
      const capabilities = await this.dependencies.request<SystemCapabilities>('/api/capabilities', {signal});
      if (signal.aborted) return;
      const issue = capabilities.registration ? validateMaterial(file, capabilities.docxUpload === true) : '材料登记暂未开放。';
      if (issue) {this.patch(id, {localError: issue}); return;}
      const ticket = await this.dependencies.request<UploadTicket>('/api/uploads', {method: 'POST', signal, body: {
        purpose: 'case_document',...(item.selectedRoundId&&item.selectedRoundId!=='legacy'?{roundId:item.selectedRoundId}:{}), caseId: item.id, expectedRevision: item.revision, filename: file.name,
        size: file.size, mimeType: materialMime(file), source: DraftSourceSchema.parse(source), idempotencyKey: this.dependencies.key(),
      }});
      if (signal.aborted) {
        // A ticket can arrive just after cancellation. Cancel that session, never a later file.
        if (!this.disposed) {
          this.patch(id, {upload: {id: ticket.id, state: ticket.state}, canceled: false});
          await this.action(id, ticket.id, 'cancel');
        }
        return;
      }
      this.patch(id, {upload: {id: ticket.id, state: ticket.state}});
      const receipt = await this.dependencies.transfer(ticket, file, progress => {if (!signal.aborted) this.patch(id, {progress});}, signal);
      if (signal.aborted) return;
      const completed = await this.dependencies.request<UploadSession>(`/api/uploads/${ticket.id}/complete`, {method: 'POST', body: receipt, signal});
      if (!signal.aborted) this.patch(id, {upload: completed});
    } catch (error) {
      if (!signal.aborted) this.patch(id, error instanceof Error && !(error as {code?: string}).code ? {localError: error.message} : {error});
    } finally {this.patch(id, {transmitting: false, ...(!this.state(id)?.upload ? {actionPending: false} : {})});}
  }
  private async action(id: string, uploadId: string, action: 'cancel' | 'complete') {
    this.patch(id, {actionPending: true, error: undefined, localError: undefined});
    try {
      const upload = await this.dependencies.request<UploadSession>(`/api/uploads/${uploadId}/${action}`, {method: 'POST'});
      this.patch(id, {upload, canceled: false});
    } catch (error) {this.patch(id, {error});}
    finally {this.patch(id, {actionPending: false});}
  }
  cancel = async (id: string) => {
    const state = this.state(id);
    if (!state || state.actionPending || state.upload?.state === 'registered') return;
    if (terminalUpload(state.upload?.state)) {this.dismiss(id); return;}
    this.transfers.get(id)?.controller.abort();
    this.pending = this.pending.filter(value => value !== id);
    this.patch(id, {queued: false, transmitting: false, canceled: !state.upload,
      ...(!state.upload ? {error: undefined, localError: undefined, actionPending: state.transmitting} : {})});
    if (state.upload) await this.action(id, state.upload.id, 'cancel');
    else if (state.queued) this.transfers.delete(id);
  };
  completeAgain = async (id: string) => {
    const state = this.state(id);
    if (state?.upload?.state === 'issued' && !state.transmitting && !state.actionPending) await this.action(id, state.upload.id, 'complete');
  };
  dismiss = (id: string) => {
    const state = this.state(id);
    if (state && !state.queued && !state.transmitting && !state.actionPending && (!state.upload || terminalUpload(state.upload.state))) this.publish(this.states.filter(value => value.id !== id));
  };
  settle = (id: string, upload: UploadSession) => {
    const state = this.state(id);
    if (state?.upload?.state === 'verifying' && upload.state === 'issued') return;
    if (state?.upload?.id === upload.id && !state.transmitting && !state.actionPending && !terminalUpload(state.upload.state)) this.patch(id, {upload});
  };
  dispose() {
    this.disposed = true;
    for (const transfer of this.transfers.values()) transfer.controller.abort();
    this.pending = []; this.transfers.clear(); this.states = []; this.listeners.clear();
  }
}
