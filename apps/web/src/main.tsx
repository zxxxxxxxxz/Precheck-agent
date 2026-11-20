import React, {lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {XProvider} from '@ant-design/x';
import {App as AntApp, Button, ConfigProvider, Drawer, Dropdown, Tooltip} from 'antd';
import localeModule from 'antd/locale/zh_CN.js';
import type {Locale} from 'antd/es/locale/index.js';
// Ant Design's CJS locale typing needs interop under NodeNext; Vite unwraps its default.
const zhCN: Locale = (localeModule as unknown as {default?: Locale}).default ?? (localeModule as unknown as Locale);
import {QueryClientProvider} from '@tanstack/react-query';
import {createBrowserRouter, RouterProvider, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate} from 'react-router';
import {can} from './features/identity/permissions.ts';
import {queryClient} from './api.ts';
import {AuthBoundary, PasswordChange, useAuth} from './auth.tsx';
import {UploadProvider} from './uploads.tsx';
const AdminPage = lazy(() => import('./pages/admin.tsx').then(module => ({default: module.AdminPage})));
const CasePage = lazy(() => import('./pages/cases.tsx').then(module => ({default: module.CasePage})));
const Cases = lazy(() => import('./pages/cases.tsx').then(module => ({default: module.Cases})));
const NewCase = lazy(() => import('./pages/cases.tsx').then(module => ({default: module.NewCase})));
const RulesPage = lazy(() => import('./pages/rules.tsx').then(module => ({default: module.RulesPage})));
import {Loading, PageHeader, ShellContext, type CaseHeader, type Crumb} from './ui.tsx';
import {layout, narrowEntryTheme, theme} from './theme.ts';
import {brand, BrandLogo, NavIcon, type IconName} from './brand.tsx';
const WorkbenchPage = lazy(() => import('./pages/workbench.tsx').then(module => ({default: module.WorkbenchPage})));
import './styles.css';
import {CaseRound, WorkspaceHeader} from './features/cases/workspace-header.tsx';
import {RoundSwitcher} from './features/review/round-switcher.tsx';
import {useCapabilities} from './capabilities.ts';
const CaseAssistantPanel = lazy(() => import('./features/case-assistant/case-assistant-panel.tsx').then(module => ({default: module.CaseAssistantPanel})));
import './workspace.css';
import {overlayPresentation} from './overlays.ts';
import './overlays.css';
import {PageErrorBoundary, RouteError} from './page-error.tsx';

const navigation: {to: string; label: string; icon: IconName}[] = [
  {to: '/workbench', label: '工作台', icon: 'workbench'},
  {to: '/cases', label: '案件', icon: 'cases'},
  {to: '/rules', label: '规则中心', icon: 'rules'},
  {to: '/system', label: '系统管理', icon: 'settings'},
];
function Navigation({adminAccess, collapsed, onNavigate}: {adminAccess: boolean; collapsed?: boolean; onNavigate?: () => void}) {
  const {session} = useAuth();
  const withTip = (label: string, node: React.ReactElement) => collapsed ? <Tooltip key={label} title={label} placement="right">{node}</Tooltip> : node;
  return <nav className="main-nav" aria-label="主菜单">{navigation.filter(item => item.to !== '/rules' || can(session.allowed_actions, 'rule:read')).map(item => item.to === '/system' && !adminAccess
    ? withTip('系统管理（需管理权限）', <span key={item.to} className="nav-unavailable" aria-disabled="true" aria-label="系统管理（需管理权限）"><NavIcon name={item.icon}/><span>{item.label}</span></span>)
    : withTip(item.label, <NavLink key={item.to} to={item.to} aria-label={item.label} onClick={onNavigate}><NavIcon name={item.icon}/><span>{item.label}</span></NavLink>))}</nav>;
}
const sectionCrumb = (pathname: string): Crumb[] => pathname.startsWith('/system') ? [{title: '系统管理'}] : pathname.startsWith('/cases/new') ? [{title: '案件', to: '/cases'}, {title: '新建案件'}] : pathname.startsWith('/cases') ? [{title: '案件'}] : pathname.startsWith('/rules') ? [{title: '规则中心'}] : pathname.startsWith('/account') ? [{title: '修改密码'}] : [{title: '工作台'}];
const isWorkRoute = (pathname: string) => /^\/cases\/(?!new(?:\/|$))[^/]+/.test(pathname);
const roleLabels: Record<string, string> = {RM: 'RM', BCO: 'BCO'};
function AccountMenu({compact = false, onAction}: {compact?: boolean; onAction?: () => void}) {
  const {session, logout} = useAuth();
  const navigate = useNavigate();
  const role = session.user?.businessRole ? roleLabels[session.user.businessRole] : undefined;
  return <Dropdown trigger={['click']} placement="topLeft" menu={{items: [{key: 'identity', disabled: true, label: <span className="account-menu-identity">{session.user?.displayName}{role ? `（${role}）` : ''}<br/><span className="mono">{session.user?.username}</span></span>}, {type: 'divider'}, {key: 'password', label: '修改密码'}, {key: 'logout', label: '退出登录'}], onClick: ({key}) => {onAction?.(); if (key === 'password') navigate('/account/password'); if (key === 'logout') void logout();}}}>
    <Button type="text" className={`account-trigger${compact ? ' account-compact' : ''}`} aria-label={`账号菜单：${session.user?.displayName ?? ''}`} title={compact ? `${session.user?.displayName ?? ''}${role ? `（${role}）` : ''}` : undefined}><span className="user-avatar" aria-hidden="true">{session.user?.displayName.slice(0, 1)}</span>{!compact && <span className="account-copy"><span className="user-name">{session.user?.displayName}</span>{role && <span className="user-role">{role}</span>}</span>}{!compact && <span aria-hidden="true" className="account-caret">▴</span>}</Button>
  </Dropdown>;
}
function Shell() {
  const {session, logout, reload} = useAuth();
  const {pathname} = useLocation();
  const navigate = useNavigate();
  const topbar = useRef<HTMLElement>(null);
  const workMode = isWorkRoute(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [registered, setRegistered] = useState<{path: string; items: Crumb[]; title?: string}>();
  const [registeredCase, setRegisteredCase] = useState<{path: string; item: CaseHeader}>();
  const [stickyTop, setStickyTop] = useState<number>(layout.topbar);
  const setCrumbs = useCallback((path: string, items: Crumb[] | undefined, title?: string) => setRegistered(current => items ? {path, items, title} : current?.path === path ? undefined : current), []);
  const setCaseHeader = useCallback((path: string, item: CaseHeader | undefined) => setRegisteredCase(current => item ? {path, item} : current?.path === path ? undefined : current), []);
  const caseHeader = (workMode || pathname === '/cases') && registeredCase?.path === pathname ? registeredCase.item : undefined;
  // One case-level assistant for every workspace step; the page underneath stays usable.
  const capabilities = useCapabilities();
  const [assistantCase, setAssistantCase] = useState<string>();
  const assistantAvailable = !!caseHeader && workMode && capabilities.data?.caseAssistant?.available === true;
  useEffect(() => {if (assistantCase && assistantCase !== caseHeader?.caseId) setAssistantCase(undefined);}, [assistantCase, caseHeader?.caseId]);
  const crumbs = registered?.path === pathname ? registered.items : sectionCrumb(pathname);
  const adminAccess = session.allowed_actions.some(action => ['account:manage', 'permission:manage', 'audit:read', 'system:status'].includes(action));
  const titleText = (registered?.path === pathname && registered.title) || [...crumbs].reverse().map(crumb => crumb.title).join(' · ');
  useEffect(() => {document.title = `${titleText} · ${brand.name}`;}, [titleText]);
  // The same bar can wrap on narrow screens; reader and table offsets follow its real height.
  useLayoutEffect(() => {
    const element = topbar.current;
    if (!element) return;
    const measure = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--topbar-h', `${height}px`);
      setStickyTop(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {observer.disconnect(); document.documentElement.style.removeProperty('--topbar-h');};
  }, []);
  useEffect(() => {setMobileOpen(false); const main = document.getElementById('main-content'); main?.focus({preventScroll: true}); window.scrollTo(0, 0);}, [pathname]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {if (media.matches) setMobileOpen(false);};
    media.addEventListener('change', closeOnDesktop);
    return () => media.removeEventListener('change', closeOnDesktop);
  }, []);
  const chrome = useMemo(() => ({setCrumbs, setCaseHeader, stickyTop}), [setCrumbs, setCaseHeader, stickyTop]);
  return <ShellContext.Provider value={chrome}><UploadProvider><div className={`app-shell workspace-mode${workMode ? ' work-mode' : ''}${pathname === '/cases/new' ? ' intake-mode' : ''}`}>
    <a className="skip-link" href="#main-content">跳至主要内容</a>
    <Drawer title={brand.name} placement="left" size={256} open={mobileOpen} onClose={() => setMobileOpen(false)} destroyOnHidden styles={{body: {padding: 20}}} footer={<AccountMenu onAction={() => setMobileOpen(false)}/>}>
      <div className="mobile-brand"><BrandLogo/></div><Navigation adminAccess={adminAccess} onNavigate={() => setMobileOpen(false)}/>
    </Drawer>
    <div className="shell-main">
      <header ref={topbar} className="workspace-topbar">
        <WorkspaceHeader item={caseHeader} round={caseHeader ? <RoundSwitcher caseId={caseHeader.caseId} caseStatus={caseHeader.status} closed={caseHeader.status === 'closed'} fallback={<CaseRound item={caseHeader}/>}/> : undefined} assistant={assistantAvailable ? <Button className="workspace-assistant-trigger" icon={<NavIcon name="chat"/>} aria-expanded={assistantCase === caseHeader!.caseId} onClick={() => setAssistantCase(current => current ? undefined : caseHeader!.caseId)}>案件助手</Button> : undefined} caseRoute={pathname.startsWith('/cases')} account={<AccountMenu/>} menu={<Button type="text" className="workspace-menu" icon={<NavIcon name="menu"/>} aria-label="打开主菜单" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>菜单</Button>} links={<>{navigation.filter(entry => (entry.to !== '/rules' || can(session.allowed_actions, 'rule:read')) && (entry.to !== '/system' || adminAccess)).map(entry => <NavLink key={entry.to} to={entry.to}>{entry.label}</NavLink>)}</>}/>
      </header>
      <main id="main-content" className="content" tabIndex={-1}><PageErrorBoundary resetKey={pathname}><Suspense fallback={<Loading/>}><Routes>
        <Route path="/" element={<Navigate to="/workbench" replace/>}/><Route path="/login" element={<Navigate to="/workbench" replace/>}/>
        <Route path="/workbench" element={<WorkbenchPage/>}/><Route path="/cases" element={<Cases/>}/><Route path="/cases/new" element={<NewCase/>}/>
        <Route path="/cases/:caseId/:tab" element={<CasePage/>}/><Route path="/cases/:caseId" element={<CasePage/>}/>
        <Route path="/rules" element={<RulesPage/>}/><Route path="/rules/:configId" element={<RulesPage/>}/>
        <Route path="/system/*" element={<AdminPage/>}/><Route path="/account/password" element={<PasswordChange onSuccess={reload} logout={logout}/>}/>
        <Route path="*" element={<><PageHeader title="页面不存在"/><section className="panel"><Link to="/workbench">返回工作台</Link></section></>}/>
      </Routes></Suspense></PageErrorBoundary></main>
      {assistantAvailable && assistantCase === caseHeader!.caseId && <Suspense fallback={null}><CaseAssistantPanel caseId={assistantCase} open onClose={() => setAssistantCase(undefined)}/></Suspense>}
    </div>
  </div></UploadProvider></ShellContext.Provider>;
}
const router = createBrowserRouter([{path: '*', element: <Shell/>, errorElement: <RouteError/>}]);
function useNarrowEntry() {
  const query = '(max-width: 620px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {const media = window.matchMedia(query); const update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update);}, []);
  return narrow;
}
function App() {
  const narrow = useNarrowEntry();
  return <XProvider locale={zhCN} theme={theme} {...overlayPresentation} button={{autoInsertSpace: false}}><ConfigProvider theme={narrow ? narrowEntryTheme : undefined}><AntApp><QueryClientProvider client={queryClient}><AuthBoundary><RouterProvider router={router}/></AuthBoundary></QueryClientProvider></AntApp></ConfigProvider></XProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
