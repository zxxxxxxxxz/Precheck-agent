import type { AuthorizedScope, ServiceIdentity } from '@hsbc/contracts/identity';
import type { P0ToolName, ToolInput } from '@hsbc/contracts/tools';

export type AgentTaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
export interface AgentTaskRecord {
  id: string; contextId: string; caseId: string; revision: number;
  state: AgentTaskState; cancelRequested?: boolean; updatedAt: string;
  artifactRefs?: string[];
}
/** Implementations must recheck scope/revision and enqueue with a PG outbox in one transaction. */
export interface AgentTaskPort {
  submit(input: { messageId: string; scope: AuthorizedScope; input: string }): Promise<AgentTaskRecord>;
  get(id: string, scope: AuthorizedScope): Promise<AgentTaskRecord | null>;
  requestCancel(id: string, scope: AuthorizedScope): Promise<AgentTaskRecord | null>;
}
export interface ProtocolAuthorizer {
  authenticate(header: string | undefined): Promise<ServiceIdentity>;
  authorize(identity: ServiceIdentity, action: string, scope?: { caseId: string; revision: number; taskId?: string }): Promise<AuthorizedScope>;
}
export interface ToolPort {
  call<T extends P0ToolName>(name: T, input: ToolInput<T>, scope: AuthorizedScope): Promise<Record<string, unknown>>;
}
