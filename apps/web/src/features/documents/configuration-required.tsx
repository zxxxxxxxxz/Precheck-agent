import React from 'react';
import {Alert} from 'antd';
import {Link} from 'react-router';
import {can} from '../identity/permissions.ts';
import type {CaseSummary} from '../cases/types.ts';
import {caseMaterialsPath} from '../cases/workspace-navigation.ts';
import {semantic} from '../../theme.ts';

export function ConfigurationRequired({item}: {item: CaseSummary}) {
  return <Alert className="notice" type="warning" showIcon styles={{root: {background: semantic.warningBg}}} title="材料解析等待审核配置" description={<>
    <p>尚未启动解析。{can(item.allowed_actions, 'case:configure') ? '请在材料区选择已发布的审核配置，保存后返回解析。' : '请联系本案经办人员完成审核配置后再解析。'}</p>
    <Link to={caseMaterialsPath(item.id, item.selectedRoundId)}>前往材料区</Link>
  </>}/>;
}
