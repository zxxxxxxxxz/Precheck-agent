import type {ConfigProviderProps} from 'antd';

/** Shared presentation for declarative dialogs, App.useApp() confirmations and drawers. */
export const overlayPresentation = {
  modal: {classNames: {
    root: 'workspace-dialog', container: 'workspace-overlay', header: 'workspace-overlay-header',
    title: 'workspace-overlay-title', body: 'workspace-overlay-body', footer: 'workspace-overlay-footer',
    close: 'workspace-dialog-close',
  }},
  drawer: {classNames: {
    section: 'workspace-overlay workspace-drawer', header: 'workspace-overlay-header',
    title: 'workspace-overlay-title', body: 'workspace-overlay-body', footer: 'workspace-overlay-footer',
  }},
} satisfies Pick<ConfigProviderProps, 'modal' | 'drawer'>;
