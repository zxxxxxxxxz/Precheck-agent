import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadP1Environment} from '../infra/dev/p1-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const webOrigin = 'http://127.0.0.1:5173';
export const apiOrigin = 'http://127.0.0.1:3001';

const loopback = /^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/;
/** The default instance keeps the team pair; a named instance previews on the pair it was initialized with. */
export function previewOrigins(env) {
  const api = `http://127.0.0.1:${env.P1_PORT}`;
  if (env.P1_MODE !== 'local' || env.P1_HOST !== '127.0.0.1' || !loopback.test(env.P1_ORIGIN ?? '') || !loopback.test(api) || env.P1_ORIGIN === api ||
      env.P1_NATIVE_INSTANCE === undefined && (env.P1_ORIGIN !== webOrigin || api !== apiOrigin)) {
    throw new Error('preview_environment_mismatch');
  }
  return {web: env.P1_ORIGIN, api};
}
export function assertPreviewEnvironment(env) { previewOrigins(env); }

export function sourceState(directory = root) {
  const git = (...args) => execFileSync('git', args, {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  const paths = ['apps', 'packages', 'scripts', 'infra', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'];
  const split = value => value.split('\0').filter(Boolean);
  return {
    commit: git('rev-parse', '--short=12', 'HEAD'),
    branch: git('branch', '--show-current') || '(detached HEAD)',
    changed: split(git('diff', '--name-only', '-z', 'HEAD', '--', ...paths)).length,
    untracked: split(git('ls-files', '--others', '--exclude-standard', '-z', '--', ...paths)).length,
  };
}

// Do not follow redirects, send cookies, or print response bodies/CSRF tokens.
export async function checkApi(origin = apiOrigin, transport = fetch) {
  if (!loopback.test(origin)) throw new Error('preview_api_target_mismatch');
  const read = async path => {
    let response;
    try {
      response = await transport(`${origin}${path}`, {redirect: 'error', signal: AbortSignal.timeout(5000)});
    } catch { throw new Error('preview_api_unreachable'); }
    if (!response.ok) throw new Error('preview_api_not_ready');
    try { return await response.json(); } catch { throw new Error('preview_api_invalid_response'); }
  };
  const health = await read('/api/health/ready');
  if (health?.status !== 'ready' || health.version !== 'p1') throw new Error('preview_api_not_application');
  const session = await read('/api/auth/session');
  if (session?.authenticated !== false || session.user || !Array.isArray(session.allowed_actions) ||
      session.allowed_actions.length !== 0 || typeof session.csrf !== 'string' || !session.csrf) {
    throw new Error('preview_api_unexpected_identity');
  }
}

const help = {
  preview_environment_mismatch: '本机配置应为 local、127.0.0.1:5173 → 127.0.0.1:3001；命名实例使用其初始化时登记的本机端口。请核对本机环境配置。',
  preview_api_target_mismatch: '统一预览只连接本机 API。',
  preview_api_unreachable: '无法连接本机 API；先启动与当前实例对应的 API（默认实例为 dev:team:api）。',
  preview_api_not_ready: '本机 API 未就绪；检查隔离数据库、迁移与 API 启动终端。',
  preview_api_invalid_response: 'API 返回格式异常；检查当前实例 API 端口对应的服务。',
  preview_api_not_application: 'API 端口未返回正式应用的就绪响应；不能把专用合成预览当作协作入口。',
  preview_api_unexpected_identity: '无凭据请求却返回登录身份或异常会话；请检查是否误连固定账号夹具。',
};

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== '--check')) throw new Error('preview_usage');
  process.chdir(root);
  const state = sourceState();
  let env;
  try { env = loadP1Environment(); } catch { throw new Error('preview_local_environment_unavailable'); }
  const origins = previewOrigins(env);
  console.log(`协作预览 · 当前工作树\n代码目录：${root}\n分支：${state.branch} · 提交：${state.commit}`);
  console.log(`Web：${origins.web}/cases\nAPI：${origins.api} · 本机隔离环境 · 使用真实登录与权限`);
  console.log(`未提交的代码/运行配置：${state.changed} 个已跟踪文件变更，${state.untracked} 个未跟踪文件。`);
  if (state.changed || state.untracked) console.log('当前界面包含本机改动；队友仅拉取上述提交无法复现。交接前需整理并同步任务范围内的代码及资源。');
  await checkApi(origins.api);
  console.log('API 就绪与未登录会话检查通过。Worker、上传、模型及业务权限须另行验证。');
  if (args[0] === '--check') return;
  const {createServer} = await import('vite');
  const server = await createServer({
    root: resolve(root, 'apps/web'), configFile: resolve(root, 'apps/web/vite.config.ts'),
    server: {host: '127.0.0.1', port: Number(new URL(origins.web).port), strictPort: true, proxy: {'/api': {target: origins.api, changeOrigin: false}}},
  });
  try { await server.listen(); } catch {
    await server.close();
    throw new Error('preview_web_start_failed');
  }
  server.printUrls();
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = help[error.message] ?? ({
      preview_usage: '用法：dev:preview 或 dev:preview:check。',
      preview_local_environment_unavailable: '本机隔离配置缺失或校验失败；先运行 env:p1:init 和 env:p1:doctor，不要复制他人的 .env 或加载 .env.remote。',
      preview_web_start_failed: 'Web 启动失败；检查当前实例的 Web 端口是否已被占用及 Vite 配置。不自动换端口或停止其他进程。',
    })[error.message] ?? '预览检查失败；请检查 Git、依赖及本机环境。';
    console.error(message);
    process.exitCode = 1;
  });
}
