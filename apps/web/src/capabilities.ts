import {useQuery} from '@tanstack/react-query';
import {api} from './api.ts';

export interface SystemCapabilities {intake?: {available: boolean; reason?: string; localModel?: string; cloudModel?: string}; draftAttachments?: boolean; registration: boolean; parsing: boolean; automaticPreparse: boolean; cloudReview: boolean; cloudTranslation: boolean; documentTranslation?: boolean; documentReader: boolean; logicalDirectory: boolean; evidenceSearch: boolean; versionComparison: boolean; docxUpload?: boolean; docxPreview?: boolean; mockValidation?: boolean; mockReader?: boolean; reviewLoop?: boolean; reviewConfiguration?: boolean; caseAssistant?: {available: boolean; reason: string | null; model: string | null}}

export function useCapabilities() {
  const query = useQuery({queryKey: ['system-capabilities'], queryFn: ({signal}) => api<SystemCapabilities>('/api/capabilities', {signal}), refetchInterval: 15_000, staleTime: 0});
  return {...query, data: query.error ? undefined : query.data};
}
