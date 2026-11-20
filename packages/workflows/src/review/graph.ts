import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { AppError } from '@hsbc/server/shared/errors';
import type { ClaimedWork } from '@hsbc/server/infrastructure/jobs/types';
import { reviewHash as inputHash, type ReviewSnapshot } from '@hsbc/server/modules/review/service';
import { reviewDocumentAgent, requestReviewDocument } from '@hsbc/server/protocols/a2a/review-document';
import type { ReviewDocumentReceipt } from '@hsbc/server/agents/document-evidence/contracts';

const State=Annotation.Root({runId:Annotation<string>(),snapshotHash:Annotation<string>(),documentReceipt:Annotation<ReviewDocumentReceipt>(),evaluated:Annotation<boolean>()});

/** Graph nodes use durable domain receipts. A crash replays the same references;
 * the final business transaction and the PG work epoch fence all result writes. */
export async function executeReviewGraph(invoke:()=>Promise<void>,snapshot:ReviewSnapshot,work:ClaimedWork,verify:()=>Promise<ReviewDocumentReceipt>){
  const snapshotHash=inputHash(snapshot),doc=reviewDocumentAgent(work,snapshot,verify);
  const graph=new StateGraph(State)
    .addNode('document_evidence',async state=>({documentReceipt:await requestReviewDocument(doc,state.runId,state.snapshotHash)}))
    .addNode('deterministic_checks',async()=>{await invoke();return {evaluated:true};})
    .addEdge(START,'document_evidence').addEdge('document_evidence','deterministic_checks').addEdge('deterministic_checks',END).compile();
  const state=await graph.invoke({runId:work.owner_id,snapshotHash});
  if(!state.evaluated)throw new AppError(409,'review_graph_incomplete');
}
