import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { build as viteBuild } from 'vite';

const workspaces = ['apps', 'packages'].flatMap(group => readdirSync(group).filter(name => existsSync(`${group}/${name}/package.json`)).map(name => `${group}/${name}`));
const manifests = workspaces.map(directory => ({ directory, manifest: JSON.parse(readFileSync(`${directory}/package.json`, 'utf8')) }));
// Only third-party packages are external. Workspace imports must be included in each deployable bundle.
const external = [...new Set(manifests.flatMap(({ manifest }) => Object.keys(manifest.dependencies ?? {}).filter(name => !name.startsWith('@hsbc/'))))];
for (const directory of workspaces) rmSync(`${directory}/dist`, { recursive: true, force: true });
const entries = new Map();
for (const { directory, manifest } of manifests.filter(({ directory }) => directory.startsWith('packages/'))) {
  for (const source of Object.values(manifest.exports ?? {})) {
    const entry = `${directory}/${source.replace(/^\.\//, '')}`;
    entries.set(entry.replace('/src/', '/dist/').replace(/\.tsx?$/, '.js'), entry);
  }
}
for (const app of ['api', 'worker']) {
  for (const output of ['application', 'p1']) entries.set(`apps/${app}/dist/${output}.js`, `apps/${app}/src/application.ts`);
  for (const output of ['experiments/p0', 'main']) entries.set(`apps/${app}/dist/${output}.js`, `apps/${app}/src/experiments/p0.ts`);
}
for (const path of ['modules/documents/engine/thread', 'modules/materials/draft-attachments/thread', 'modules/materials/draft-attachments/parser']) {
  entries.set(`packages/server/dist/${path}.js`, `packages/server/src/${path}.ts`);
}
for (const [outfile, entry] of entries) {
  if (!existsSync(entry)) throw new Error(`Missing build entry: ${entry}`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node24', external, outfile, sourcemap: true });
}
const web = await viteBuild({ root: 'apps/web' });
for (const result of Array.isArray(web) ? web : [web]) {
  if (!('output' in result)) continue;
  for (const output of result.output) {
    if (output.type !== 'chunk') continue;
    if (Object.keys(output.modules).some(path => /\/(?:server|workflows|testing)\/src\//.test(path) || path.includes('__vite-browser-external'))) {
      throw new Error('Browser bundle contains server code or a Node built-in');
    }
  }
}
console.log(`Built ${entries.size} Node entries and Web; workspace dependencies bundled, third-party versions unchanged.`);
