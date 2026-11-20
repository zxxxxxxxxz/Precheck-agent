import React, {useState} from 'react';
import {Alert, Button, Segmented, Select, Table} from 'antd';
import type {TableProps} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {api} from './api.ts';
import {formatTime} from './shared/format.ts';
import {Blank, blocksView, ErrorNotice, Loading, RefreshNotice} from './ui.tsx';
import {mockStatusLabels, scopedMockRuns, validateMockRun} from './mockValidation.ts';
import './source-reader.css';

export function MockReader({base, documentId, parseRevision, sourceSha256}: {base: string; documentId: string; parseRevision: string; sourceSha256: string}) {
  const [selectedId, setSelectedId] = useState<string>();
  const runs = useQuery({queryKey:['document-mock-runs', documentId, parseRevision, base], queryFn: async ({signal}) => {const response = await api<{items:unknown[]}>(`${base}/mock-runs`, {signal}); return scopedMockRuns(response.items, documentId, parseRevision);}, refetchInterval: 15_000});
  const items = blocksView(runs) ? [] : runs.data ?? [];
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  return <section className="mock-reader" aria-label="合成识别验证">
    <div className="mock-reader-bar"><span>合成验证记录</span><Select aria-label="选择合成识别验证记录" value={selected?.id} disabled={!items.length} onChange={setSelectedId} options={items.map(item => ({value:item.id, label:`p${item.pageNumber} · ${formatTime(item.createdAt)} · ${mockStatusLabels[item.status]}`}))}/></div>
    {blocksView(runs) ? <ErrorNotice error={runs.error} retry={() => void runs.refetch()}/> : <RefreshNotice query={runs} retry={() => void runs.refetch()}/>}
    {runs.isPending ? <Loading/> : selected ? <MockRun key={selected.id} base={base} runId={selected.id} documentId={documentId} parseRevision={parseRevision} sourceSha256={sourceSha256}/> : !blocksView(runs) && <Blank title="暂无合成识别验证记录"/>}
  </section>;
}
function MockRun({base, runId, documentId, parseRevision, sourceSha256}: {base:string; runId:string; documentId:string; parseRevision:string; sourceSha256:string}) {
  const [imageView, setImageView] = useState<'original'|'mock'>('mock');
  const [selectedOverlay, setSelectedOverlay] = useState<string>();
  const [imageFailed, setImageFailed] = useState(false);
  const detail = useQuery({queryKey:['document-mock-run', base, documentId, parseRevision, runId], queryFn: async ({signal}) => validateMockRun(await api<unknown>(`${base}/mock-runs/${encodeURIComponent(runId)}`, {signal}), documentId, parseRevision, sourceSha256, runId), refetchInterval: query => ['pending','running'].includes(query.state.data?.status ?? '') ? 2000 : 15_000});
  if (detail.isPending) return <Loading/>;
  if (blocksView(detail)) return <ErrorNotice error={detail.error} retry={() => void detail.refetch()}/>;
  const data = detail.data;
  if (!data) return null;
  const result = data.result;
  const comparisons = result?.comparisons ?? data.overlays.map(overlay => ({overlayId:overlay.id, expected:overlay.text, actual:'', matched:false, regionIds:[], characterErrorRate:0}));
  const columns: TableProps<typeof comparisons[number]>['columns'] = [
    {title:'期望值', dataIndex:'expected', render:(value:string,row) => <button type="button" className="evidence-value-link" onClick={() => setSelectedOverlay(row.overlayId)} aria-label={`定位替换区域：${value}`}>{value}</button>},
    {title:'实际识别', dataIndex:'actual', render:(value:string) => value || <span className="muted">{result ? '未识别到' : '等待识别'}</span>},
    {title:'结果', key:'match', width:100, render:(_, row) => <span className={result && !row.matched ? 'tone-warning' : ''}>{!result ? '待验证' : row.matched ? '一致' : '不一致'}</span>},
  ];
  const selected = data.overlays.find(overlay => overlay.id === selectedOverlay);
  const selectedRegions = result?.regions.filter(region => result.comparisons.find(comparison => comparison.overlayId === selectedOverlay)?.regionIds.includes(region.id)) ?? [];
  const imageAvailable = imageView === 'original' || !!data.mockImageSha256;
  return <>
    <RefreshNotice query={detail} retry={() => void detail.refetch()}/>
    <div className="mock-reader-content">
      <div className="mock-reader-image-pane"><div className="mock-reader-image-bar"><Segmented<'original'|'mock'> aria-label="原始页或 Mock 页" value={imageView} onChange={value => {setImageView(value); setImageFailed(false);}} options={[{value:'original',label:'原始页'},{value:'mock',label:'Mock 页'}]}/><span className="muted">p{data.pageNumber} · {mockStatusLabels[data.status]}</span></div>
        {imageFailed ? <Alert type="error" showIcon title="图像暂不可用，请重新查询记录并检查读取权限。" action={<Button onClick={() => {setImageFailed(false); void detail.refetch();}}>重新查询</Button>}/> : imageAvailable ? <div className="mock-reader-image"><svg viewBox={`0 0 ${data.width} ${data.height}`} role="img" aria-label={`${imageView === 'original' ? '原始页' : 'Mock 合成替换页'}第 ${data.pageNumber} 页`}><image href={`${base}/mock-runs/${encodeURIComponent(runId)}/images/${imageView}`} width={data.width} height={data.height} onError={() => setImageFailed(true)}/>{selected && <rect className="mock-overlay-selected" x={selected.box.x} y={selected.box.y} width={selected.box.width} height={selected.box.height}/>} {imageView === 'mock' && selectedRegions.map(region => <polygon key={region.id} className="mock-region-selected" points={region.polygon.map(point => point.join(',')).join(' ')}/>)}</svg></div> : <Blank title="Mock 图像尚未生成"/>}
      </div>
      <aside className="mock-reader-results" aria-label="合成样本期望值与实际结果"><h3>期望值与实际识别</h3><Table rowKey="overlayId" dataSource={comparisons} columns={columns} pagination={false} scroll={{x:400}} rowClassName={row => row.overlayId === selectedOverlay ? 'mock-row-selected' : ''}/>{result && <p className="muted">Mock 页 · {result.comparisons.filter(row => row.matched).length} / {result.comparisons.length} 项一致</p>}{!!result?.coverageGaps.length && <div className="source-reader-gaps"><strong>验证缺口</strong><ul>{result.coverageGaps.map(gap => <li key={gap}>{mockGapLabel(gap)}</li>)}</ul></div>}{data.errorCode && <Alert type="warning" showIcon title="本次验证未完整完成，请核对记录状态和缺口。"/>}</aside>
    </div>
  </>;
}
function mockGapLabel(code: string) {const labels:Record<string,string> = {ocr_failed:'文字识别未完成', ocr_partial:'部分区域识别未完成', mock_text_not_found:'替换文字未被识别', outside_regions_detected:'识别到替换区域外的文字',synthetic_text_mismatch:'合成替换值与识别结果不一致'}; return labels[code] ?? '部分验证内容未完整处理，请核对图像与识别结果。';}
