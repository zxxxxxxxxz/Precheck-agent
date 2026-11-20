import {useEffect} from 'react';
import {App} from 'antd';
import {useBlocker} from 'react-router';

/** Keep unsubmitted configuration/fact changes in memory until explicit navigation consent. */
export function useReviewUnsavedChanges(dirty: boolean) {
  const {modal} = App.useApp();
  const blocker = useBlocker(({currentLocation, nextLocation}) => dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault();};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const dialog = modal.confirm({title: '放弃未保存的修改并离开？', content: '未提交内容仍在此页面；选择继续编辑可返回核对。', okText: '放弃并离开', cancelText: '继续编辑', onOk: () => blocker.proceed(), onCancel: () => blocker.reset()});
    return () => dialog.destroy();
  }, [blocker, modal]);
}
