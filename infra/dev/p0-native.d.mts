export const ROOT: string;
export interface P0Environment extends Record<string, string> {
  P0_ENV: 'p0-native';
  P0_INSTANCE_ID: string;
  P0_PROJECT_ROOT: string;
  DATABASE_URL: string;
  AUTH_DATABASE_URL: string;
  WORKER_DATABASE_URL: string;
  CHECKPOINT_DATABASE_URL: string;
  MIGRATION_DATABASE_URL: string;
  REDIS_URL: string;
  SESSION_SECRET: string;
}
export interface P0LegacyInstanceMarker {
  kind: 'hsbc-p0-native-v1';
  projectRoot: string;
  instanceId: string;
}
export interface P0NamedInstanceMarker {
  kind: 'hsbc-p0-native-v2';
  projectRoot: string;
  instanceId: string;
  instanceName: string;
  localDir: string;
  postgresPort: number;
  redisPort: number;
}
export type P0InstanceMarker = P0LegacyInstanceMarker | P0NamedInstanceMarker;
export interface P0Paths {
  instanceName?: string;
  localDir: string;
  envFile: string;
  markerFile: string;
  postgresDir: string;
  redisDir: string;
}
export function getP0Paths(instanceName?: string, root?: string): P0Paths;
export function loadP0Environment(): P0Environment;
export function parseEnv(text: string): Record<string, string>;
export function assertP0Target(env: Record<string, string>, marker: P0InstanceMarker, root?: string, instanceName?: string): P0Environment;
export function assertPostgresIdentity(pidText: string, command: string, dataDir?: string, port?: number): number;
export function assertRedisIdentity(infoText: string, expectedPid: number, configPath?: string, port?: number): void;
