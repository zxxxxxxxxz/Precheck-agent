
export type BusinessRole = 'RM' | 'BCO';

export interface Actor { accountId: string; personId: string; authVersion: number; sessionKey?: string }
