export interface Session {
  authenticated: boolean;
  csrf: string;
  user?: {accountId: string; personId: string; username: string; displayName: string; businessRole?: 'RM' | 'BCO' | null; mustChangePassword: boolean};
  allowed_actions: string[];
  idleExpiresAt?: string;
  absoluteExpiresAt?: string;
}
