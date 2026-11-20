import React from 'react';
import {Link} from 'react-router';
import {BrandLogo, brand} from '../../brand.tsx';
import {CaseStatus, type CaseHeader} from '../../ui.tsx';
import {workspaceSteps} from './workspace-navigation.ts';
import {caseIdentifier} from './identity.ts';

/** Shown in place of the round selector until the case's rounds are known. */
export function CaseRound({item}: {item: CaseHeader}) {
  return <div className="workspace-round-static"><span>{item.roundNumber ? `第 ${item.roundNumber} 轮` : item.legacyRound ? '历史未分轮' : '待准备轮次'}</span><CaseStatus status={item.status}/></div>;
}

// Two bands from the bank mockup: a 36px utility bar and a 56px brand and journey bar.
// The case number, round and status appear here once; pages below do not repeat them.
export function WorkspaceHeader({item, account, menu, links, caseRoute, round, assistant}: {
  item?: CaseHeader; account: React.ReactNode; menu: React.ReactNode; links: React.ReactNode; caseRoute: boolean; round?: React.ReactNode; assistant?: React.ReactNode;
}) {
  const caseNumber = item ? item.caseNumber || item.title || caseIdentifier({...item, id: item.caseId}) : undefined;
  return <>
    <div className="workspace-utility"><nav className="workspace-utility-links" aria-label="全局导航">{menu}{links}</nav><div className="workspace-account">{account}</div></div>
    <div className={`workspace-header${caseRoute ? '' : ' workspace-header-global'}`}>
      <Link className="workspace-brand" to="/cases" aria-label={`${brand.name}案件工作台`}><BrandLogo/><strong>{brand.name}</strong><span>担保预审</span></Link>
      <div className="workspace-case-identity">{item && <><h1 title={caseNumber}>{caseNumber}</h1>{item.caseNumber && item.title && item.title !== item.caseNumber && <span title={item.title}>{item.title}</span>}</>}</div>
      {caseRoute && <nav className="workspace-journey" aria-label="预审流程">{workspaceSteps(item).map(step => step.to ? <Link key={step.key} to={step.to} aria-current={step.active ? 'step' : undefined}><span>{step.number}</span>{step.label}</Link> : <span key={step.key} aria-disabled="true" title="进入案件后查看"><span>{step.number}</span>{step.label}</span>)}</nav>}
      <div className="workspace-state">{item && <>{round ?? <CaseRound item={item}/>}{assistant}</>}</div>
    </div>
  </>;
}
