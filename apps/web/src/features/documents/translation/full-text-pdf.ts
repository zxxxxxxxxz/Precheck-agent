import {PDFDocument} from 'pdf-lib';
import {FullTextError, fullTextRows, fullTextSummary, type FullTextSnapshot} from './full-text.ts';
import {translationReason} from './presentation.ts';

export function translationPdfFilename(filename: string, incomplete: boolean) {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().slice(0, 120) || '材料';
  return `${stem}_全文中文参考译文${incomplete ? '_未完整' : ''}.pdf`;
}
export interface TranslationPdfBlock {text: string; kind: 'title' | 'heading' | 'body' | 'note'}
export function translationPdfBlocks(filename: string, snapshot: FullTextSnapshot): TranslationPdfBlock[] {
  const summary = fullTextSummary(snapshot);
  const blocks: TranslationPdfBlock[] = [
    {kind: 'title', text: '全文中文参考译文'},
    {kind: 'heading', text: filename},
    {kind: 'note', text: '未经人工核对，不替代正式中文版材料。按已识别原文段落顺序整理，不复刻原件版式；图片及未识别内容请核对原件。'},
    {kind: 'note', text: `共 ${summary.total} 段 · 已译 ${summary.translated} 段 · 无英文原文保留 ${summary.original} 段 · 未译 ${summary.missing} 段 · 译文需核对 ${summary.review} 段`},
  ];
  if (summary.missing) blocks.push({kind: 'heading', text: '全文翻译尚未完成：以下保留全部段落位置，并标明缺失。'});
  for (const [index, row] of fullTextRows(snapshot).entries()) {
    const pages = row.target.source.pageNumbers;
    blocks.push({kind: 'heading', text: `段落 ${index + 1}${pages.length ? ` · 原文第 ${pages.join('、')} 页` : ' · 原文文字结构'}`});
    if (row.segment) {
      blocks.push({kind: 'body', text: row.segment.translatedText!});
      if (row.segment.status === 'needs_review') blocks.push({kind: 'note', text: `此段译文需核对：${row.segment.reasonCodes.map(translationReason).join('；') || '请结合原文检查译文。'}`});
      if (row.segment.simulated) blocks.push({kind: 'note', text: '模拟译文，仅用于功能验证。'});
    } else if (row.original) {
      blocks.push({kind: 'note', text: '此段未识别到英文，保留原文。'}, {kind: 'body', text: row.target.sourceText!});
    } else {
      blocks.push({kind: 'note', text: `【尚无译文】${row.target.reasonCodes.map(translationReason).join('；') || '翻译未完成，请核对原文。'}`});
      if (row.target.sourceText) blocks.push({kind: 'body', text: `原文：${row.target.sourceText}`});
    }
    if (row.target.sourceWarnings.length || row.segment?.sourceWarnings.length) blocks.push({kind: 'note', text: '原文有识别或定位提示，请结合原件核对。'});
  }
  return blocks;
}

/** Line breaking uses measured glyph widths, including CJK and unbroken identifiers. */
export function wrapTranslationText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = '';
    // Keep amounts, dates and English words together whenever they fit a line.
    const tokens = paragraph.match(/[A-Za-z0-9][A-Za-z0-9.,%:/_@+#&'()\-]*|./gu) ?? [];
    for (const token of tokens) {
      if (line && measure(line + token) > width) {lines.push(line); line = '';}
      if (measure(token) <= width) {line += token; continue;}
      for (const char of token) {
        if (line && measure(line + char) > width) {lines.push(line); line = '';}
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Local system fonts avoid sending document text or requesting external font assets. */
export async function fullTextPdf(filename: string, snapshot: FullTextSnapshot, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!snapshot.targets.items.length) throw new FullTextError('暂无可导出的全文段落。');
  await document.fonts.ready;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${filename} - 全文中文参考译文`);
  pdf.setSubject('中文参考译文，未经人工核对');
  const width = 794, height = 1123, margin = 62, scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale; canvas.height = height * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new FullTextError('浏览器无法生成 PDF，请使用支持画布的浏览器重试。');
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  let y = margin, page = 0;
  const start = () => {
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = '#FFFFFF'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#DB0011'; context.fillRect(margin, 35, 36, 3);
    context.textBaseline = 'top'; y = margin;
  };
  const flush = async () => {
    signal?.throwIfAborted();
    if (++page > 500) throw new FullTextError('译文超过 500 页，暂无法一次导出，请联系管理员。');
    context.font = `12px ${font}`; context.fillStyle = '#666666';
    context.fillText('中文参考译文 · 未经人工核对', margin, height - 42);
    context.fillText(String(page), width - margin - context.measureText(String(page)).width, height - 42);
    const image = await pdf.embedPng(canvas.toDataURL('image/png'));
    pdf.addPage([595.28, 841.89]).drawImage(image, {x: 0, y: 0, width: 595.28, height: 841.89});
    // Let the browser paint progress and process cancellation between pages.
    await new Promise(resolve => setTimeout(resolve, 0));
    start();
  };
  try {
    start();
    for (const block of translationPdfBlocks(filename, snapshot)) {
      signal?.throwIfAborted();
      const size = block.kind === 'title' ? 25 : block.kind === 'heading' ? 16 : block.kind === 'body' ? 15 : 12;
      const lineHeight = Math.ceil(size * 1.65);
      const style = () => {context.font = `${block.kind === 'title' || block.kind === 'heading' ? '600 ' : ''}${size}px ${font}`; context.fillStyle = block.kind === 'note' ? '#666666' : '#333333';};
      style();
      const lines = wrapTranslationText(block.text, width - margin * 2, value => context.measureText(value).width);
      if ((block.kind === 'heading' || block.kind === 'title') && y + lineHeight * Math.min(lines.length + 2, 6) > height - margin) await flush();
      for (const line of lines) {
        if (y + lineHeight > height - margin) await flush();
        style(); context.fillText(line, margin, y); y += lineHeight;
      }
      y += block.kind === 'heading' ? 8 : 14;
    }
    await flush(); signal?.throwIfAborted();
    return new Uint8Array(await pdf.save());
  } finally {canvas.width = 0; canvas.height = 0;}
}
