import React from 'react';
import {Button} from 'antd';
import {processingNotes} from './processing-notes.ts';
import './processing-notes.css';

type Note = ReturnType<typeof processingNotes>[number];
export function ProcessingNotesList({notes, onLocate, availablePages, grouped = true, compact = false}: {
  notes: readonly Note[];
  onLocate?: (page: number, codes: readonly string[]) => void;
  availablePages?: readonly number[];
  grouped?: boolean;
  compact?: boolean;
}) {
  const explanation = (note: Note) => <><p>{note.explanation}</p><p className="processing-note-action">{note.action}</p></>;
  const list = (items: readonly Note[]) => <ul className={`processing-note-list${compact ? ' is-compact' : ''}`}>{items.map(note => <li key={note.key}>
    {compact ? <details className="processing-note-detail" onClick={event => event.stopPropagation()}>
      <summary>{note.title}</summary>
      {explanation(note)}
    </details> : <><strong>{note.title}</strong>{explanation(note)}</>}
    {onLocate && <div className="processing-note-pages" aria-label="提示涉及的页面">{note.pageNumbers.length ? note.pageNumbers.map(page => {
      const available = !availablePages || availablePages.includes(page);
      return <Button key={page} type="link" className="link-button" disabled={!available} title={available ? '查看原页' : '本页尚无可用预览，请核对原文件'} aria-label={`查看第 ${page} 页：${note.title}`} onClick={() => onLocate(page, note.codes)}>第 {page} 页</Button>;
    }) : <span className="muted">尚无具体页码，请核对原文件</span>}</div>}
  </li>)}</ul>;
  if (!notes.length) return null;
  if (!grouped) return list(notes);
  return <div className="processing-notes">{([['processing', '解析限制'], ['review', '待人工核对']] as const).map(([category, label]) => {
    const items = notes.filter(note => note.category === category);
    return items.length ? <section key={category} className="processing-note-group" aria-label={label}><h3>{label}</h3>{list(items)}</section> : null;
  })}</div>;
}
