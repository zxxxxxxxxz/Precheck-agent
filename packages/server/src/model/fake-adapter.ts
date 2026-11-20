import type { ModelProfile, ModelRequest } from '@hsbc/contracts/model';
import type { AdapterOutput, ModelAdapter } from './gateway.js';

/** In-memory contract fixture. It makes no HTTP calls and never represents a real provider. */
export class FakeModelAdapter implements ModelAdapter {
  readonly version = 'fake-adapter/1';
  readonly simulated = true;
  calls = 0;
  constructor(private readonly respond?: (request: ModelRequest, profile: ModelProfile, signal: AbortSignal) => Promise<AdapterOutput>) {}
  async generate(request: ModelRequest, profile: ModelProfile, signal: AbortSignal): Promise<AdapterOutput> {
    this.calls++;
    if (this.respond) return this.respond(request, profile, signal);
    return {
      actualModel: profile.model, actualProvider: profile.allowedActualProviders[0]!,
      providerRequestId: `synthetic-${request.attemptId}`, finishReason: 'stop', usage: null,
      text: 'Synthetic contract response; no model inference occurred.',
      ...(request.outputSchemaRef ? { structured: { summary: 'synthetic' } } : {}),
    };
  }
}

export const p0FakeProfiles: ModelProfile[] = [
  { id: 'local-qwen', version: 'p0-fake-1', provider: 'local-vllm', locality: 'local', model: 'synthetic-local-qwen',
    allowedActualProviders: ['synthetic-self-hosted'], capabilities: ['text'], allowedTasks: ['extract_fields', 'resolve_candidates'], adapterId: 'fake-local', fallback: 'disabled' },
  { id: 'cloud-direct', version: 'p0-fake-1', provider: 'cloud-direct', locality: 'cloud', model: 'synthetic-cloud-review',
    allowedActualProviders: ['synthetic-cloud-provider'], capabilities: ['text', 'json_schema'], allowedTasks: ['cloud_review', 'translate_clause'], adapterId: 'fake-cloud', fallback: 'disabled' },
  { id: 'openrouter', version: 'p0-fake-1', provider: 'openrouter', locality: 'cloud', model: 'synthetic-openrouter-review',
    allowedActualProviders: ['synthetic-routed-provider'], capabilities: ['text', 'json_schema'], allowedTasks: ['cloud_review', 'translate_clause'], adapterId: 'fake-router', fallback: 'disabled' },
];
