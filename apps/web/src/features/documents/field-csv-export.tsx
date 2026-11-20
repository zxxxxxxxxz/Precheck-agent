import React, {useEffect, useState} from 'react';
import {Button} from 'antd';
import {documentFieldsCsv, documentFieldsCsvFilename, type FieldCsvInput} from './field-csv.ts';

export function FieldCsvExport({input,label}: {input: FieldCsvInput;label?:string}) {
  const [download, setDownload] = useState<{csv: string; url: string}>();
  const csv = documentFieldsCsv(input);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
    setDownload({csv, url});
    return () => URL.revokeObjectURL(url);
  }, [csv]);
  return <Button size="small" href={download?.csv === csv ? download.url : undefined}
    download={documentFieldsCsvFilename(input.filename)} disabled={!input.rows.length || download?.csv !== csv}
    aria-label={label??'导出当前字段 CSV'} title={label?'导出已生成的识别记录，保留完整条件、原始记录及来源':'导出当前筛选字段，保留完整条件、原始记录及来源'}>{label??'导出当前字段'}</Button>;
}
