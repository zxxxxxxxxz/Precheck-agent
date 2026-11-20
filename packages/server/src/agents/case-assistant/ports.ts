import type {CaseAssistConfig} from '../../modules/case-assistant/config.js';
import type {CaseAssistJob,CaseAssistMode,CaseAssistModelHooks} from '../../modules/case-assistant/model.js';
import type {NerClient} from '../../infrastructure/integrations/inference.js';

/** The agent only sequences privacy → model → domain completion; it holds no SQL or permissions. */
export interface CaseAssistantPorts {
  job:CaseAssistJob;mode:CaseAssistMode;config:CaseAssistConfig;signal:AbortSignal;fetcher?:typeof fetch;ner?:Pick<NerClient,'entities'>;
  blocks:Array<{id:string;text:string}>;
  /** Blocks that may be left out when they cannot be protected; every other block fails the turn. */
  isolatable?:readonly string[];
  hooks:CaseAssistModelHooks;
  /** Receives the schema-valid output with private placeholders restored, and the blocks that were left out. */
  complete(restored:unknown,sourceRef:(wireRef:string)=>string,withheld:readonly string[]):Promise<void>;
}
