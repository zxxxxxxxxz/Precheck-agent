import React, {useState} from 'react';
import {Button, Input} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import {api} from './api.ts';
import {Blank, ErrorNotice, Loading} from './ui.tsx';
import {formatPages, gapLabel} from './features/documents/presentation.ts';
import type {DocumentRetrievalResult} from './features/documents/types.ts';
import type {CaseSummary} from './features/cases/types.ts';
function GapList({gaps}: {gaps:readonly string[]}) {return gaps.length ? <ul className="gap-list">{[...new Set(gaps)].map(gap => <li key={gap}>{gapLabel(gap)}</li>)}</ul> : null;}
export function SearchPanel({item, documentId, parseRevision, onSelect}: {item: Pick<CaseSummary, 'id' | 'revision'>; documentId: string; parseRevision: string; onSelect: (ids: string[], page?: number) => void}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const result = useQuery({queryKey: ['evidence-search', item.id, item.revision, documentId, parseRevision, query], enabled: !!query, queryFn: ({signal}) => api<DocumentRetrievalResult>(`/api/cases/${item.id}/evidence/search`, {method: 'POST', signal, body: {query, documentId, parseRevision, expectedRevision: item.revision}})});
  return <div className="evidence-panel"><form className="review-search" role="search" onSubmit={event => {event.preventDefault(); if (text.trim()) {if (query === text.trim()) void result.refetch(); else setQuery(text.trim());}}}><Input aria-label="检索原文关键词或条款编号" value={text} onChange={event => setText(event.target.value)} placeholder="关键词或条款编号" maxLength={500}/><Button htmlType="submit" loading={result.isFetching}>查找</Button></form><ErrorNotice error={result.error} retry={() => void result.refetch()}/>{!query ? null : result.isFetching ? <Loading/> : !result.error && result.data && <><p className="muted pane-note">{result.data.matches.some(match => match.chunk.sourceNodeIds?.length) ? '已搜索页面及源结构' : `已搜索 ${result.data.searchedPageNumbers.length} 页`}，匹配 {result.data.matches.length} 段</p>{result.data.matches.length ? result.data.matches.map(({chunk, reason}) => <article className="search-hit" key={chunk.id}><div className="search-hit-head"><>{chunk.pageNumbers.length > 0 && <Button className="link-button" type="link" onClick={() => onSelect(chunk.anchorIds, chunk.pageNumbers[0])}>第 {formatPages(chunk.pageNumbers)} 页</Button>}{chunk.sourceNodeIds?.map((nodeId,i) => <Link key={nodeId} to={`/cases/${item.id}/review?document=${encodeURIComponent(documentId)}&parse=${encodeURIComponent(parseRevision)}&view=source&sourceNode=${encodeURIComponent(nodeId)}`}>源结构{i + 1}</Link>)}</>{reason === 'mandatory_dependency' && <span className="muted">关联引用</span>}</div><p className="evidence-excerpt clamp">{chunk.text}</p><GapList gaps={chunk.coverageGaps}/></article>) : <Blank title="未找到匹配证据"/>}<GapList gaps={result.data.coverageGaps}/>{result.data.status === 'partial' && <p className="muted pane-note">证据范围尚不完整，请核对缺口与原件。</p>}</>}</div>;
}
