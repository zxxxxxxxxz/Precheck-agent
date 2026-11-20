import React from 'react';
import {App, ConfigProvider} from 'antd';

// The rule workspace shares the app-wide compact scale; its portalled dialogs keep their own class.
export function ConfigurationAppearance({children}: {children: React.ReactNode}) {
  return <ConfigProvider modal={{className: 'rules-dialog'}}>
    <App component={false}>{children}</App>
  </ConfigProvider>;
}
