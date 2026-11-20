import OSS from 'ali-oss';
import { ECSRAMRoleCredentialsProvider } from '@alicloud/credentials';
import type { Readable } from 'node:stream';
import { ServiceError } from './http.js';

export interface UploadConfig {
  enabled: boolean; bucket: string; region: string; endpoint?: string; publicEndpoint?: string; prefix: string;
  maxBytes: number; maxPages: number; ttlSeconds: number; orphanGraceSeconds: number;
  docxEnabled?: boolean; maxDocxBytes?: number;
  credential?: { accessKeyId: string; accessKeySecret: string; securityToken?: string; expiresAt?: string };
}
export interface ObjectVersion { versionId: string; size: number; lastModified: Date }
export interface SignedPost { host: string; fields: Record<string, string>; expiresAt: string }
export interface ObjectStore {
  sign(key: string, size: number, expiresAt: Date, contentType?: string): Promise<SignedPost>;
  head(key: string, versionId?: string): Promise<ObjectVersion>;
  read(key: string, versionId: string, maxBytes: number, range?: { start: number; end: number }): Promise<Buffer>;
  versions(key: string): Promise<ObjectVersion[]>;
  deleteVersion(key: string, versionId: string): Promise<void>;
  /** Derived evidence only; originals still use browser direct upload. */
  put?(key: string, bytes: Buffer, contentType: 'image/png' | 'application/json' | 'application/pdf'): Promise<ObjectVersion>;
}
// The maintained DefinitelyTyped package omits V4 and versioned methods present
// in ali-oss 6.23.0. This small local surface follows that pinned SDK's source.
interface VersionedOss {
  put(key: string, bytes: Buffer, options: { mime: string; headers: Record<string, string> }): Promise<{ res: { headers: Record<string, string> } }>;
  signPostObjectPolicyV4(policy: unknown, date: Date): string;
  head(key: string, options?: { versionId?: string; headers?: Record<string, string> }): Promise<{ res: { headers: Record<string, string> } }>;
  getStream(key: string, options: { subres: { versionId: string }; headers?: Record<string, string> }): Promise<{ stream: Readable; res: { headers: Record<string, string> } }>;
  getBucketVersions(query: { prefix: string; maxKeys: number; keyMarker?: string; versionIdMarker?: string }): Promise<{
    objects: { name: string; versionId: string; size: number; lastModified: string }[];
    isTruncated: boolean; nextKeyMarker?: string; nextVersionIdMarker?: string;
  }>;
  delete(key: string, options: { versionId: string }): Promise<unknown>;
}
function version(value: string | undefined): string {
  if (!value || value === 'null' || value.length > 1024) throw new ServiceError('oss_versioning_required');
  return value;
}
function sanitize(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  return new ServiceError(status === 404 ? 'oss_not_found' : [401, 403].includes(status) ? 'oss_authorization_failed' : 'oss_unavailable', status === 0 || status === 429 || status >= 500);
}
export class OssObjectStore implements ObjectStore {
  private provider?: ECSRAMRoleCredentialsProvider;
  constructor(private config: UploadConfig) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*\/$/.test(config.prefix) || config.prefix.includes('..')) throw new ServiceError('oss_invalid_prefix');
    for (const endpoint of [config.endpoint, config.publicEndpoint].filter(Boolean)) {
      const url = new URL(endpoint!);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ServiceError('oss_invalid_endpoint');
    }
  }
  private key(key: string) { if (!key.startsWith(this.config.prefix) || key.includes('..')) throw new ServiceError('oss_invalid_key'); }
  private async client() {
    if (!this.config.enabled) throw new ServiceError('upload_unavailable');
    try {
      let credential = this.config.credential;
      if (!credential) {
        this.provider ??= ECSRAMRoleCredentialsProvider.builder().withDisableIMDSv1(true).withReadTimeout(5000).withConnectTimeout(2000).withAsyncCredentialUpdateEnabled(false).build();
        const session = await this.provider.getSession();
        credential = { accessKeyId: session.accessKeyId, accessKeySecret: session.accessKeySecret, securityToken: session.securityToken, expiresAt: session.expiration };
      }
      if (!credential.accessKeyId || !credential.accessKeySecret) throw new ServiceError('oss_credentials_unavailable');
      if (credential.securityToken && (!credential.expiresAt || !Number.isFinite(Date.parse(credential.expiresAt)))) throw new ServiceError('oss_credential_expiry_required');
      const sdk = new OSS({ region: `oss-${this.config.region.replace(/^oss-/, '')}`, bucket: this.config.bucket, endpoint: this.config.endpoint,
        accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret, stsToken: credential.securityToken,
        secure: true, timeout: 30_000, authorizationV4: true, retryMax: 0 } as OSS.Options) as unknown as VersionedOss;
      return { sdk, credential };
    } catch (error) { throw sanitize(error); }
  }
  async sign(key: string, size: number, expiresAt: Date, contentType = 'application/pdf'): Promise<SignedPost> {
    this.key(key);
    if (!['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg'].includes(contentType)) throw new ServiceError('upload_unsupported_type');
    const { sdk, credential } = await this.client(); const now = new Date();
    const expiry = new Date(Math.min(expiresAt.getTime(), now.getTime() + this.config.ttlSeconds * 1000,
      credential.expiresAt ? Date.parse(credential.expiresAt) - 30_000 : Infinity));
    if (expiry.getTime() <= now.getTime()) throw new ServiceError('oss_credentials_expired');
    const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const region = this.config.region.replace(/^oss-/, '');
    const fields: Record<string, string> = { key, 'Content-Type': contentType, success_action_status: '201',
      'x-oss-signature-version': 'OSS4-HMAC-SHA256', 'x-oss-date': date,
      'x-oss-credential': `${credential.accessKeyId}/${date.slice(0, 8)}/${region}/oss/aliyun_v4_request` };
    if (credential.securityToken) fields['x-oss-security-token'] = credential.securityToken;
    const policy = { expiration: expiry.toISOString(), conditions: [ { bucket: this.config.bucket },
      ...Object.entries(fields).map(([name, value]) => [ 'eq', `$${name}`, value ]), [ 'content-length-range', size, size ] ] };
    fields.policy = Buffer.from(JSON.stringify(policy)).toString('base64');
    fields['x-oss-signature'] = sdk.signPostObjectPolicyV4(policy, now);
    const endpoint = new URL(this.config.publicEndpoint ?? `https://oss-${region}.aliyuncs.com`);
    if (!endpoint.hostname.startsWith(`${this.config.bucket}.`)) endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
    return { host: endpoint.origin, fields, expiresAt: expiry.toISOString() };
  }
  async head(key: string, versionId?: string): Promise<ObjectVersion> {
    this.key(key);
    try {
      const { sdk } = await this.client();
      const result = await sdk.head(key, { ...(versionId ? { versionId: version(versionId) } : {}), headers: { 'Accept-Encoding': 'identity' } });
      const headers = result.res.headers; const actual = version(headers['x-oss-version-id']);
      if (versionId && actual !== versionId) throw new ServiceError('oss_version_mismatch');
      const size = Number(headers['content-length']), lastModified = new Date(headers['last-modified']);
      if (!Number.isSafeInteger(size) || size <= 0 || !Number.isFinite(lastModified.getTime())) throw new ServiceError('oss_invalid_metadata');
      return { versionId: actual, size, lastModified };
    } catch (error) { throw sanitize(error); }
  }
  async read(key: string, versionId: string, maxBytes: number, range?: { start: number; end: number }): Promise<Buffer> {
    this.key(key);
    try {
      const { sdk } = await this.client();
      // Unlike get/head/delete, ali-oss 6.23.0 getStream does not translate
      // options.versionId. Pass it as a signed subresource to pin the object.
      const result = await sdk.getStream(key, { subres: { versionId: version(versionId) }, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) } });
      if (!result.stream) throw new ServiceError('oss_invalid_response');
      try {
        if (version(result.res.headers['x-oss-version-id']) !== versionId) throw new ServiceError('oss_version_mismatch');
        if (Number(result.res.headers['content-length']) > maxBytes) throw new ServiceError('upload_size_exceeded');
        const chunks: Buffer[] = []; let count = 0;
        for await (const part of result.stream) { const chunk = Buffer.from(part); count += chunk.length;
          if (count > maxBytes) throw new ServiceError('upload_size_exceeded'); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks);
        if (range && bytes.length !== range.end - range.start + 1) throw new ServiceError('oss_range_mismatch');
        return bytes;
      } finally { result.stream.destroy(); }
    } catch (error) { throw sanitize(error); }
  }
  async versions(key: string): Promise<ObjectVersion[]> {
    this.key(key);
    try {
      const { sdk } = await this.client(); let keyMarker: string | undefined, versionIdMarker: string | undefined;
      const versions: ObjectVersion[] = [];
      for (let page = 0; page < 100; page++) {
        // The SDK serializes every query key, even undefined marker values.
        // Omit missing markers so the wire query and V4 signature agree.
        const response = await sdk.getBucketVersions({ prefix: key, maxKeys: 100,
          ...(keyMarker ? { keyMarker } : {}), ...(versionIdMarker ? { versionIdMarker } : {}) });
        versions.push(...response.objects.filter(item => item.name === key).map(item => ({ versionId: version(item.versionId), size: item.size, lastModified: new Date(item.lastModified) })));
        if (!response.isTruncated) return versions;
        keyMarker = response.nextKeyMarker; versionIdMarker = response.nextVersionIdMarker;
        if (!keyMarker) throw new ServiceError('oss_invalid_response');
      }
      throw new ServiceError('oss_version_scan_limit');
    } catch (error) { throw sanitize(error); }
  }
  async deleteVersion(key: string, versionId: string) {
    this.key(key);
    try { const { sdk } = await this.client(); await sdk.delete(key, { versionId: version(versionId) }); } catch (error) { throw sanitize(error); }
  }
  async put(key: string, bytes: Buffer, contentType: 'image/png' | 'application/json' | 'application/pdf'): Promise<ObjectVersion> {
    this.key(key);
    if (!key.startsWith(`${this.config.prefix}derived/`) || !bytes.length || bytes.length > 64 * 1024 * 1024) throw new ServiceError('derived_object_invalid');
    try {
      const { sdk } = await this.client();
      const result = await sdk.put(key, bytes, { mime: contentType, headers: { 'Cache-Control': 'private, no-store' } });
      const versionId = version(result.res.headers['x-oss-version-id']);
      const object = await this.head(key, versionId);
      if (object.size !== bytes.length) throw new ServiceError('derived_object_size_mismatch');
      return object;
    } catch (error) { throw sanitize(error); }
  }
}
