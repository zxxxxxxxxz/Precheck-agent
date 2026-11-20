import React from 'react';
import {Alert} from 'antd';
import type {ProcessingStatus} from './types.ts';
import './recovery-notice.css';
import {recoveryPresentation} from './recovery-presentation.ts';

export function RecoveryNotice({status}:{status:ProcessingStatus}){
  if(status.status!=='failed')return null;
  const presentation=recoveryPresentation(status);
  return <div className="recovery-notices"><Alert type="warning" showIcon={false} title={presentation.title}
    className="recovery-notice" classNames={{section:'recovery-notice-copy',title:'recovery-notice-title',description:'recovery-notice-description'}}
    description={presentation.description}/></div>;
}
