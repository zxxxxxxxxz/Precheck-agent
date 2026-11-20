export const ROOT: string;
export interface P1Environment extends Record<string, string> {
  P1_ENV: 'p1-native';
  P1_MODE: 'local';
  P1_INSTANCE_ID: string;
  P1_PROJECT_ROOT: string;
  P1_DATABASE_URL: string;
  P1_WORKER_DATABASE_URL: string;
  P1_CHECKPOINT_DATABASE_URL: string;
  P1_MIGRATION_DATABASE_URL: string;
  P1_REDIS_URL: string;
  P1_SESSION_SECRET: string;
}
export interface P1LegacyInstanceMarker {
  kind: 'hsbc-p0-native-v1';
  projectRoot: string;
  instanceId: string;
}
export interface P1NamedInstanceMarker {
  kind: 'hsbc-p0-native-v2';
  projectRoot: string;
  instanceId: string;
  instanceName: string;
  localDir: string;
  postgresPort: number;
  redisPort: number;
}
export type P1InstanceMarker = P1LegacyInstanceMarker | P1NamedInstanceMarker;
export interface P1Paths {
  instanceName?: string;
  localDir: string;
  envFile: string;
  markerFile: string;
  postgresDir: string;
  redisDir: string;
}
export function getP1Paths(instanceName?: string, root?: string): P1Paths;
export function loadP1Environment(): P1Environment;
export function parseEnv(text: string): Record<string, string>;
export function assertP1Target(env: Record<string, string>, marker: P1InstanceMarker, root?: string, instanceName?: string): P1Environment;
export function assertPostgresIdentity(pidText: string, command: string, dataDir?: string, port?: number): number;
export function assertRedisIdentity(infoText: string, expectedPid: number, configPath?: string, port?: number): void;
