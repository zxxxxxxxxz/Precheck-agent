import React, {useEffect, useRef, useState} from 'react';
import {Button} from 'antd';

export interface QuickPrompt {key: string; label: string; disabled?: boolean; selected?: boolean}

/** One native scroll container: wheel, touch and keyboard focus all reach the hidden actions. */
export function QuickPrompts({items, onSelect}: {items: QuickPrompt[]; onSelect: (key: string) => void}) {
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({left: false, right: false});
  const keys = items.map(item => item.key).join(':');
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => setEdges({left: element.scrollLeft > 1, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1});
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
      const next = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + delta));
      if (next !== element.scrollLeft) {event.preventDefault(); element.scrollLeft = next;}
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener('scroll', measure);
    element.addEventListener('wheel', wheel, {passive: false});
    measure();
    return () => {observer.disconnect(); element.removeEventListener('scroll', measure); element.removeEventListener('wheel', wheel);};
  }, [keys]);
  const move = (direction: number) => {
    const element = list.current;
    if (element) element.scrollBy({left: direction * element.clientWidth * .8, behavior: 'auto'});
  };
  return <div className="case-assistant-prompts" role="group" aria-label="对话快捷操作">
    <Button className="case-assistant-prompt-arrow" type="text" size="small" aria-label="向左滚动快捷操作" disabled={!edges.left} onClick={() => move(-1)}>‹</Button>
    <div ref={list} className="case-assistant-prompt-list" onFocus={event => {
      if (event.target instanceof HTMLElement) event.target.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }}>
      {items.map(item => <Button key={item.key} size="small" className="case-assistant-prompt" disabled={item.disabled} aria-pressed={item.selected}
        onClick={() => onSelect(item.key)}>{item.label}</Button>)}
    </div>
    <Button className="case-assistant-prompt-arrow" type="text" size="small" aria-label="向右滚动快捷操作" disabled={!edges.right} onClick={() => move(1)}>›</Button>
  </div>;
}
