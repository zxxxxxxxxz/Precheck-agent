import React from 'react';
import type {FieldDecision} from './field-decision.ts';

export function FieldDecisionStrip({decision,bankRule=false}:{decision:FieldDecision;bankRule?:boolean}) {
  return <div className="field-decision-strip" aria-label={bankRule?'从内容对照到业务处置':'从字面对照到业务处置'}>
    {(['literal','conclusion','action'] as const).map((key,index)=><React.Fragment key={key}>
      {index>0&&<span className="field-decision-arrow" aria-hidden="true">→</span>}
      <div className={`field-decision-step field-decision-${key} field-decision-${decision[key].tone}`}>
        <small>{[bankRule?'01 内容对照':'01 字面对照',bankRule?'02 规则核对':'02 语义结论','03 业务处置'][index]}</small>
        <strong>{decision[key].label}</strong><span>{decision[key].note}</span>
      </div>
    </React.Fragment>)}
  </div>;
}
