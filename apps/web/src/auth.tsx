import React, {createContext, useContext, useEffect, useRef, useState} from 'react';
import {Alert, Button, ConfigProvider, Form, Input} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {api, ApiError, clearSensitiveState, onSecurityChange, readSession, setCsrf} from './api.ts';
import type {Session} from './features/identity/types.ts';
import {ErrorNotice, Loading} from './ui.tsx';
import {brand, BrandLogo} from './brand.tsx';

const AuthContext = createContext<{session: Session; reload: () => Promise<void>; logout: () => Promise<void>} | null>(null);
export function useAuth() {const value = useContext(AuthContext); if (!value) throw new Error('Auth context unavailable'); return value;}
export function AuthBoundary({children}: {children: React.ReactNode}) {
  const [epoch, setEpoch] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [authError, setAuthError] = useState<unknown>();
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [requestUnauthorized, setRequestUnauthorized] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const sessionRecoveryAttempts = useRef(0);
  const previousIdentity = useRef<string | undefined>(undefined);
  const sessionQuery = useQuery({queryKey: ['session', epoch], queryFn: ({signal}) => readSession(signal), refetchInterval: 30_000, staleTime: 0});
  const session = sessionQuery.data;
  useEffect(() => {
    if (!redirecting) return;
    // Navigate from the boundary even if a session refresh unmounted the form
    // while login was in flight. The new document reads the new session cookie.
    clearSensitiveState();
    window.location.replace('/workbench');
  }, [redirecting]);
  useEffect(() => {if (!session?.authenticated || session.user?.mustChangePassword) document.title = brand.name;}, [session?.authenticated, session?.user?.mustChangePassword]);
  const reload = async () => {clearSensitiveState(); previousIdentity.current = undefined; setRequestUnauthorized(false); setEpoch(value => value + 1);};
  useEffect(() => {
    onSecurityChange(status => {clearSensitiveState(); previousIdentity.current = undefined; setBlocked(status === 403); setRequestUnauthorized(status === 401); setEpoch(value => value + 1);});
    return () => onSecurityChange(undefined);
  }, []);
  useEffect(() => {
    const error = sessionQuery.error;
    if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) return;
    clearSensitiveState(); previousIdentity.current = undefined; setSessionExpired(true);
    // A destroyed session is followed by one new anonymous pre-login request.
    // Bound recovery if a misconfigured server keeps rejecting anonymous requests.
    if (sessionRecoveryAttempts.current++ < 1) setEpoch(value => value + 1);
  }, [sessionQuery.error]);
  useEffect(() => {
    if (!session) return;
    sessionRecoveryAttempts.current = 0;
    const identity = `${session.user?.accountId ?? 'anonymous'}:${session.user?.mustChangePassword ?? false}:${[...session.allowed_actions].sort().join(',')}`;
    if (previousIdentity.current !== undefined && identity !== previousIdentity.current) {void reload(); return;}
    previousIdentity.current = identity;
    setCsrf(session.csrf);
  }, [session]);
  useEffect(() => {
    if (!session?.authenticated || session.user?.mustChangePassword) return;
    let lastActivity = Date.now();
    const recordActivity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== 'visible' || Date.now() - lastActivity < 60_000) return;
      lastActivity = Date.now();
      void api('/api/auth/session/activity', {method: 'POST'}).catch(() => {});
    };
    window.addEventListener('pointerdown', recordActivity);
    window.addEventListener('keydown', recordActivity);
    return () => {window.removeEventListener('pointerdown', recordActivity); window.removeEventListener('keydown', recordActivity);};
  }, [session?.user?.accountId, epoch]);
  const logout = async () => {
    try {await api('/api/auth/logout', {method: 'POST', security: false}); setAuthError(undefined); setLogoutFailed(false); history.replaceState(null, '', '/workbench');}
    catch (error) {setAuthError(error); setLogoutFailed(true);}
    finally {setBlocked(false); await reload();}
  };
  if (redirecting) return <Loading fullPage label="正在进入工作台"/>;
  if (sessionQuery.isPending) return <Loading fullPage label="正在确认登录状态"/>;
  if (sessionQuery.error instanceof ApiError && [401, 403].includes(sessionQuery.error.status) && sessionRecoveryAttempts.current === 0) return <Loading fullPage label="登录已过期，正在清除页面数据"/>;
  if (sessionQuery.error || !session) return <main className="connection-page"><h1>暂时无法连接</h1><ErrorNotice error={sessionQuery.error} retry={() => void sessionQuery.refetch()}/></main>;
  const identity = `${session.user?.accountId ?? 'anonymous'}:${session.user?.mustChangePassword ?? false}:${[...session.allowed_actions].sort().join(',')}`;
  if (previousIdentity.current !== undefined && previousIdentity.current !== identity) return <Loading fullPage label="正在更新访问权限"/>;
  if (logoutFailed) return <main className="connection-page"><h1>尚未完成退出</h1><p>当前页面的数据已清除。网络恢复后请再次退出，以结束服务器会话。</p><ErrorNotice error={authError}/><Button onClick={() => void logout()}>再次退出</Button></main>;
  if (!session.authenticated) return <Login expired={sessionExpired} onSuccess={() => setRedirecting(true)}/>;
  // A business endpoint can reject a cookie while the session endpoint still accepts it.
  // Keep protected content unmounted instead of repeatedly retrying it after recovery.
  if (requestUnauthorized) return <main className="connection-page"><h1>登录状态需要重新确认</h1><p>已清除案件数据。服务未能一致确认当前登录状态，请重新登录后继续。</p><ErrorNotice error={authError}/><Button type="primary" onClick={() => void logout()}>重新登录</Button></main>;
  if (session.user?.mustChangePassword) return <PasswordChange forced onSuccess={reload} logout={logout}/>;
  return <AuthContext.Provider value={{session, reload, logout}}><ErrorNotice error={authError}/>{blocked ? <main className="connection-page"><h1>访问权限已变化</h1><p>已清除当前页面的案件数据。重新进入工作台查看仍有权访问的内容。</p><Button type="primary" onClick={() => {history.replaceState(null, '', '/workbench'); setBlocked(false); void reload();}}>返回工作台</Button></main> : <React.Fragment key={`${session.user?.accountId}:${epoch}`}>{children}</React.Fragment>}</AuthContext.Provider>;
}
function Login({onSuccess, expired = false}: {onSuccess: () => void; expired?: boolean}) {
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<unknown>();
  const [form] = Form.useForm();
  const submit = async (values: {username: string; password: string}) => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true); setError(undefined);
    try {await api('/api/auth/login', {method: 'POST', body: values, security: false}); form.resetFields(); onSuccess();}
    catch (failure) {submitting.current = false; setPending(false); setError(failure); form.setFieldValue('password', '');}
  };
  return <div className="login-layout">
    <header className="login-header"><div><BrandLogo/></div></header>
    <main className="login-content"><section className="login-form" aria-labelledby="login-title">
      <h1 id="login-title">{brand.name}</h1><p className="login-subtitle">{brand.subtitle}</p>
      <h2>登录</h2><ErrorNotice error={error}/>{expired && <Alert className="notice" type="warning" showIcon title="登录已过期或权限已变化，请重新登录。"/>}
      <ConfigProvider theme={{token: {controlHeightLG: 46}, components: {Input: {inputFontSizeLG: 14}, Button: {controlHeightLG: 52}}}}><Form form={form} layout="vertical" size="large" onFinish={submit} requiredMark={false} disabled={pending} clearOnDestroy>
        <Form.Item name="username" label="账号" rules={[{required: true, whitespace: true, message: '请输入账号'}]}><Input className="login-username" autoComplete="username" maxLength={128} autoFocus/></Form.Item>
        <Form.Item name="password" label="密码" rules={[{required: true, message: '请输入密码'}]}><Input.Password className="login-password" autoComplete="current-password" maxLength={256}/></Form.Item>
        <Button className="login-submit" type="primary" htmlType="submit" loading={pending} block>登录</Button>
      </Form></ConfigProvider><p className="help-text">忘记密码？请联系账号管理员重置。</p>
    </section><div className="login-visual" aria-hidden="true"><img src="/brand/international-business.jpg" alt="" width="2880" height="1386" fetchPriority="high"/></div></main>
  </div>;
}
export function PasswordChange({forced = false, onSuccess, logout}: {forced?: boolean; onSuccess: () => Promise<void>; logout: () => Promise<void>}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [form] = Form.useForm();
  const submit = async (values: {currentPassword: string; newPassword: string}) => {
    setPending(true); setError(undefined);
    try {await api('/api/auth/password/change', {method: 'POST', body: {currentPassword: values.currentPassword, newPassword: values.newPassword}, security: false}); form.resetFields(); await onSuccess();}
    catch (failure) {setError(failure); form.resetFields();}
    finally {setPending(false);}
  };
  return <><div className={forced ? 'password-brand' : 'visually-hidden'}><BrandLogo/><span>{brand.name}</span></div><main className={forced ? 'password-page' : ''}><section className="panel form-panel"><h1>{forced ? '请先修改临时密码' : '修改密码'}</h1><p>设置至少 12 位的新密码。保存后所有旧会话失效，需要重新登录。</p><ErrorNotice error={error}/><Form form={form} layout="vertical" disabled={pending} onFinish={submit} clearOnDestroy><Form.Item name="currentPassword" label="当前密码" rules={[{required: true, message: '请输入当前密码'}]}><Input.Password autoComplete="current-password"/></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{required: true, min: 12, max: 128, message: '请输入 12–128 位新密码'}]}><Input.Password autoComplete="new-password"/></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{required: true, message: '请再次输入新密码'}, ({getFieldValue}) => ({validator(_, value) {return !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致'));}})]}><Input.Password autoComplete="new-password"/></Form.Item><div className="actions"><Button type="primary" htmlType="submit" loading={pending}>保存并重新登录</Button><Button onClick={() => void logout()}>退出登录</Button></div></Form></section></main></>;
}
