import {useLayoutEffect,useRef} from 'react';

/** Measure the real prelude, including wrapped notices and expanded translation controls. */
export function useDeskHeight(ready:boolean) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const desk=ref.current;
    if(!ready||!desk)return;
    let frame=0;
    const measure=()=>{
      if(!desk.getClientRects().length)return;
      const top=desk.getBoundingClientRect().top+window.scrollY;
      const height=`${Math.max(460,window.innerHeight-top-16)}px`;
      if(desk.style.getPropertyValue('--field-desk-height')!==height)desk.style.setProperty('--field-desk-height',height);
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(schedule);
    for(let ancestor=desk.parentElement;ancestor;ancestor=ancestor.parentElement)observer.observe(ancestor);
    const header=document.querySelector('.workspace-topbar');if(header)observer.observe(header);
    window.addEventListener('resize',schedule);measure();
    return()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);};
  },[ready]);
  return ref;
}
