import React, {Component, type ReactNode} from 'react';
import {Button} from 'antd';
import {useRouteError} from 'react-router';
import {isPageLoadError} from './page-load-error.ts';
import './page-error.css';

export function PageError({error}: {error: unknown}) {
  const loadFailed = isPageLoadError(error);
  return <section className="page-error" role="alert" aria-labelledby="page-error-title">
    <h1 id="page-error-title">{loadFailed ? '页面暂时无法加载' : '页面暂时无法显示'}</h1>
    <p>{loadFailed ? '页面可能已更新，或网络连接暂时中断。请刷新页面重试。' : '请刷新页面重试；如果仍无法打开，请联系管理员。'}</p>
    <p className="page-error-note">刷新会重新打开当前页面，尚未保存的输入可能丢失。</p>
    <Button type="primary" onClick={() => window.location.reload()}>刷新页面</Button>
  </section>;
}

// Keep the shell and upload provider mounted when a lazy page fails. Reset only
// the error on navigation, without remounting healthy pages and their state.
export class PageErrorBoundary extends Component<{children: ReactNode; resetKey: string}, {failed: boolean; error: unknown; resetKey: string}> {
  state = {failed: false, error: undefined as unknown, resetKey: this.props.resetKey};
  static getDerivedStateFromProps(props: {resetKey: string}, state: {resetKey: string}) {
    return props.resetKey === state.resetKey ? null : {failed: false, error: undefined, resetKey: props.resetKey};
  }
  static getDerivedStateFromError(error: unknown) {return {failed: true, error};}
  render() {return this.state.failed ? <PageError error={this.state.error}/> : this.props.children;}
}

export function RouteError() {return <PageError error={useRouteError()}/>;}
