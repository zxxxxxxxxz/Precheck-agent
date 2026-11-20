import React from 'react';
import {Skeleton} from 'antd';
import {brand} from './brand.tsx';
import './loading.css';

// The branded animation (geometry and timing follow docs/previews/hsbc-loading.html) is kept for
// whole-page waits: signing in and session checks. Panels inside a page show a quiet skeleton of
// the same footprint so the layout does not jump when the content arrives.
// Render only while a request or route is pending; this is not progress reporting.
export function Loading({label = '正在加载', fullPage = false, branded = fullPage}: {label?: string; fullPage?: boolean; branded?: boolean}) {
  if (!branded) return <div className="panel-loading" role="status" aria-live="polite" aria-busy="true">
    <span className="visually-hidden">{label}</span>
    <Skeleton active title={false} paragraph={{rows: 3, width: ['72%', '96%', '48%']}}/>
  </div>;
  return <div className={`hsbc-loading${fullPage ? ' hsbc-loading--full-page' : ''}`}>
    <div className="hsbc-loading__brand-space">
      <img className="hsbc-loading__brand" src={brand.logo} width={111} height={30} alt="HSBC"/>
    </div>
    <svg className="hsbc-loading__motion" viewBox="0 0 80 64" width={80} height={64} aria-hidden="true" focusable="false">
      <path className="hsbc-loading__chevron hsbc-loading__chevron--left" d="M 34 23 L 25 32 L 34 41"/>
      <path className="hsbc-loading__chevron hsbc-loading__chevron--right" d="M 46 23 L 55 32 L 46 41"/>
    </svg>
    <p className="hsbc-loading__status" role="status" aria-atomic="true">{label}</p>
  </div>;
}
