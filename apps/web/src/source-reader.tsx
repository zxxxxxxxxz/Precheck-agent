import {previewReason} from './features/documents/processing-presentation.ts';
import React, {useEffect, useRef, useState} from 'react';
import {Alert, Button, Input, Tooltip} from 'antd';
import {useSearchParams} from 'react-router';
import {NavIcon} from './brand.tsx';
import {SearchPanel} from './evidence-search.tsx';
import {Blank} from './ui.tsx';
import {previewAvailable, readableSourceNodes, sourceGapLabel, sourceKindLabels, sourceNodeLabel, sourceNodeTrail, sourceTextPresentation, visibilityLabels} from './sourceDocument.ts';
import type {SourceDocumentResponse} from './sourceDocument.ts';
import './source-reader.css';

export function SourceReader({caseId, caseRevision, documentId, data, onPreview}: {caseId:string; caseRevision:number; documentId:string; data: SourceDocumentResponse; onPreview: (page: number) => void}) {
  const [params, setParams] = useSearchParams();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [listPage, setListPage] = useState(0);
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const directoryRef = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  const nodes = readableSourceNodes(data.source.nodes);
  const requested = params.get('sourceNode');
  const selected = data.source.nodes.find(node => node.id === requested) ?? nodes[0];
  const textPresentation = selected ? sourceTextPresentation(selected) : undefined;
  const references = selected ? data.source.nodes.filter(node => !!node.reference && node.reference.targetId !== selected.id && (node.id === selected.id || node.parentId === selected.id)) : [];
  const index = nodes.findIndex(node => node.id === selected?.id);
  const select = (id: string) => {setParams(current => {const next = new URLSearchParams(current); next.set('sourceNode', id); return next;}, {replace:true}); requestAnimationFrame(() => article.current?.focus());};
  const toggleDirectory = () => {setDirectoryOpen(value => !value); requestAnimationFrame(() => {if (directoryOpen) directoryTrigger.current?.focus(); else directoryRef.current?.querySelector('input')?.focus();});};
  useEffect(() => {article.current?.scrollTo({top:0});}, [selected?.id]);
  const matched = nodes.filter(node => !query.trim() || `${sourceNodeLabel(node)} ${sourceTextPresentation(node).text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const mappings = data.mappings.filter(mapping => mapping.sourceNodeId === selected?.id);
  const pages = [...new Set(mappings.flatMap(mapping => mapping.pageNumbers))];
  const gaps = [...new Set([...data.source.coverageGaps, ...(data.preview?.coverageGaps ?? []), ...(data.preview?.manifest?.coverageGaps ?? [])])];
  const fontChanges = data.preview?.manifest?.fonts.filter(font => font.status !== 'available') ?? [];
  return <>
    <div className="source-reader-workspace">
      {directoryOpen && <aside ref={directoryRef} className="source-reader-directory" aria-label="源结构目录">
        <div className="source-reader-search"><Input aria-label="查找源结构文字" placeholder="查找段落、单元格或文字" value={query} onChange={event => {setQuery(event.target.value); setListPage(0);}} allowClear/></div>
        <ol className="directory-list">{matched.slice(listPage * 40, (listPage + 1) * 40).map(node => <li key={node.id}><button type="button" className={`directory-item${selected?.id === node.id ? ' active' : ''}`} aria-current={selected?.id === node.id ? 'true' : undefined} onClick={() => select(node.id)}><span className="source-node-label">{sourceNodeLabel(node)}</span><span className="source-node-snippet">{node.visibility !== 'visible' && `${visibilityLabels[node.visibility]} · `}{sourceTextPresentation(node).text.slice(0,100) || '无可读文字'}</span></button></li>)}</ol>
        {!matched.length && <p className="pane-note">未找到匹配内容</p>}
        <div className="source-list-pager"><Button disabled={listPage === 0} onClick={() => setListPage(value => value - 1)}>上一组</Button><span>{matched.length} 项</span><Button disabled={(listPage + 1) * 40 >= matched.length} onClick={() => setListPage(value => value + 1)}>下一组</Button></div>
      </aside>}
      <article className="source-reader-paper" ref={article} tabIndex={-1} aria-label="DOCX 源结构原文">
        {requested && !data.source.nodes.some(node => node.id === requested) && <Alert type="warning" showIcon title="所选源结构位置不在当前解析记录中，已显示第一处可读内容。"/>}
        {!previewAvailable(data) && <Alert type="warning" showIcon title={`${previewReason(data.preview)}。仍可阅读文字结构；段落和单元格位置不等于原件页码。`}/>}
        {gaps.length > 0 && <details className="source-reader-gaps"><summary>源文件与预览核对提示</summary><ul>{[...new Set(gaps.map(sourceGapLabel))].map(label => <li key={label}>{label}</li>)}</ul></details>}
        {(data.source.fonts.length > 0 || fontChanges.length > 0) && <details className="source-reader-fonts"><summary>字体与排版{fontChanges.length ? ` · ${fontChanges.length} 项需关注` : ''}</summary><ul>{fontChanges.map((font,i) => <li key={`${font.requested}:${i}`}>{font.requested} → {font.resolved ?? '替代字体未确认'}（{font.status === 'substituted' ? '已替代' : '待确认'}）</li>)}</ul><p>原文件字体：{data.source.fonts.map(font => `${font.name}${font.embedded ? '（内嵌）' : ''}`).join('、') || '未记录'}</p></details>}
        <details className="source-reader-search-panel"><summary>检索当前材料</summary><SearchPanel item={{id:caseId, revision:caseRevision}} documentId={documentId} parseRevision={data.parseRevision} onSelect={(_ids,page) => {if(page) onPreview(page);}}/></details>
        {selected ? <div className="source-reader-node">
          <nav className="source-reader-trail" aria-label="源结构路径">{sourceNodeTrail(selected, data.source.nodes).map(node => <button type="button" key={node.id} onClick={() => select(node.id)}>{sourceKindLabels[node.kind]}</button>)}</nav>
          <div className="source-reader-node-head"><h3>{sourceNodeLabel(selected)}</h3><span className={selected.excludedFromVisibleFacts || selected.visibility !== 'visible' ? 'tone-warning' : 'muted'}>{selected.symbol ? '符号含义未确认' : textPresentation?.hasExcludedText ? '含未确认内容' : visibilityLabels[selected.visibility]}</span></div>
          {(selected.excludedFromVisibleFacts || selected.visibility !== 'visible') && <Alert type="warning" showIcon title="此内容未作为可见事实使用，请核对原文件及修订状态。"/>}
          <p className="source-reader-text">{textPresentation?.text || (selected.kind === 'image' ? '图像内容' : selected.symbol ? '符号内容待核对' : '此位置没有可读文字')}</p>
          {textPresentation?.hasExcludedText && <details className="source-reader-gaps"><summary>查看完整源文字（含未确认内容，未作为可见事实使用）</summary><p className="source-reader-text">{selected.text}</p></details>}
          {selected.symbol && <dl className="source-reader-symbol"><dt>原始符号</dt><dd>{selected.symbol.font} / {selected.symbol.charCode}</dd><dt>字符候选</dt><dd>{selected.symbol.unicodeCandidate ?? '无法确定'} · 含义未确认</dd></dl>}
          {selected.cell && <p className="muted">跨 {selected.cell.gridSpan} 列{selected.cell.verticalMerge !== 'none' && ` · ${selected.cell.verticalMerge === 'restart' ? '纵向合并起点' : '纵向合并续接'}`}</p>}
          {references.map(referenceNode => {const reference = referenceNode.reference!; return <div className="source-reference" key={referenceNode.id}><span>{reference.external ? '外部引用未读取' : '关联内容'}：</span>{reference.targetId && data.source.nodes.some(node => node.id === reference.targetId) ? <Button type="link" onClick={() => select(reference.targetId!)}>查看{reference.kind === 'footnote' ? '脚注' : reference.kind === 'endnote' ? '尾注' : reference.kind === 'comment' ? '批注' : '图像位置'}</Button> : <span>尚无可定位的源节点</span>}</div>;})}
          {selected.coverageGaps.length > 0 && <ul className="gap-list">{selected.coverageGaps.map((gap,i) => <li key={i}>{sourceGapLabel(gap)}</li>)}</ul>}
          <div className="source-reader-locator"><span>定位到{sourceKindLabels[selected.kind]}</span>{previewAvailable(data) && pages.length ? pages.map(page => <Button type="link" key={page} onClick={() => onPreview(page)}>查看预览 p{page}</Button>) : <span className="muted">无可靠页面映射</span>}{mappings.some(mapping => mapping.status === 'ambiguous') && <span className="tone-warning">存在多个定位候选</span>}</div>
        </div> : <Blank title="暂无可读源结构"/>}
      </article>
    </div>
    <footer className="review-footer"><div className="reader-tools" role="group" aria-label="源结构阅读工具"><Tooltip title={directoryOpen ? '收起源结构目录' : '展开源结构目录'}><Button type="text" ref={directoryTrigger} icon={<NavIcon name="directory"/>} aria-label={directoryOpen ? '收起源结构目录' : '展开源结构目录'} aria-expanded={directoryOpen} onClick={toggleDirectory}/></Tooltip><Tooltip title="上一处源结构"><Button type="text" icon={<NavIcon name="previous"/>} aria-label="上一处源结构" disabled={index <= 0} onClick={() => select(nodes[index - 1].id)}/></Tooltip><Tooltip title="下一处源结构"><Button type="text" icon={<NavIcon name="next"/>} aria-label="下一处源结构" disabled={index < 0 || index >= nodes.length - 1} onClick={() => select(nodes[index + 1].id)}/></Tooltip></div><span role="status" className="muted">{index >= 0 ? `源结构 ${index + 1} / ${nodes.length}` : '源结构定位'} · 原文只读</span></footer>
  </>;
}
