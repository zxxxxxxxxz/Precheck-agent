export interface Account {businessRole?: 'RM' | 'BCO' | null; id: string; personId: string; username: string; displayName: string; enabled: boolean; mustChangePassword: boolean; version: number}
export interface Person {id: string; displayName: string; enabled: boolean; businessRole?: 'RM' | 'BCO' | null; business_role?: 'RM' | 'BCO' | null; version: number}
export interface AccessGrant {id: string; personId: string; action: string; caseId: string | null; createdAt: string}
export interface AuthEvent {id: string; action: string; result: string; createdAt: string; actorId: string | null; targetId: string | null}
export interface TemporaryPassword {temporaryPassword: string; expiresAt: string; account?: Account}
