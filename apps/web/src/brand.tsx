import React from 'react';

export const brand = {
  name: '跨境通途',
  subtitle: '跨境融资智能文件审核 Agent',
  logo: '/brand/hsbc-masterbrand.svg',
  themeVersion: 'hsbc-p1-20261013',
} as const;

export function BrandLogo({compact = false}: {compact?: boolean}) {
  if (compact) return <svg className="hsbc-symbol" width="48" height="24" viewBox="0 0 60 30" role="img" aria-label="HSBC"><use href={`${brand.logo}#HSBC_MASTERBRAND_LOGO_RGB`}/></svg>;
  return <img className="hsbc-logo" src={brand.logo} width={111} height={30} alt="HSBC"/>;
}

export type IconName = 'workbench' | 'cases' | 'rules' | 'settings' | 'menu' | 'collapse' | 'expand' | 'user' | 'directory' | 'previous' | 'next' | 'fit-width' | 'rotate' | 'regions' | 'regions-off' | 'evidence' | 'chat';
// Navigation artwork is UI chrome; the official brand SVG remains unmodified.
export function NavIcon({name}: {name: IconName}) {
  const paths: Record<IconName, React.ReactNode> = {
    workbench: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    cases: <><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/><path d="M3 9h18"/></>,
    rules: <><path d="M6 3h10l3 3v15H6zM15 3v4h4M9 11h7M9 15h7M9 18h4"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><rect x="8" y="4" width="4" height="6" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="14" width="4" height="6" rx="1" fill="currentColor" stroke="none"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    chat: <><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/></>,
    collapse: <><path d="M14 7l-5 5 5 5M4 4v16"/></>,
    expand: <><path d="M10 7l5 5-5 5M20 4v16"/></>,
    directory: <><path d="M9 5h12M9 12h12M9 19h12"/><path d="M3 5h1M3 12h1M3 19h1"/></>,
    previous: <path d="m14 6-6 6 6 6"/>,
    next: <path d="m10 6 6 6-6 6"/>,
    'fit-width': <><path d="M3 4v16M21 4v16M6 12h12m-9-3-3 3 3 3m6-6 3 3-3 3"/></>,
    rotate: <><path d="M20 9a8 8 0 1 0-1 9M20 3v6h-6"/></>,
    regions: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="7" y="7" width="10" height="10" rx="1"/></>,
    'regions-off': <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l18 18"/></>,
    evidence: <><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M14 4v16M17 8h1m-1 4h1m-1 4h1"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
