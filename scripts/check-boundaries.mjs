import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/;
const excludedDirectories = new Set(['node_modules', 'dist', '.git', '.local', 'coverage']);
const dependencyDirections = new Map([
  ['@hsbc/contracts', []],
  ['@hsbc/server', ['@hsbc/contracts']],
  ['@hsbc/workflows', ['@hsbc/server', '@hsbc/contracts']],
  ['@hsbc/testing', ['@hsbc/server', '@hsbc/contracts']],
  ['@hsbc/web', ['@hsbc/contracts']],
  ['@hsbc/api', ['@hsbc/server', '@hsbc/workflows', '@hsbc/contracts']],
  ['@hsbc/worker', ['@hsbc/server', '@hsbc/workflows', '@hsbc/contracts']],
]);
// These local preview fixtures compose the real entry points. Do not broaden
// this to all scripts, or production packages could lose their public boundary.
const previewEntries = new Map([
  ['scripts/p2-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/p3-review-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/p3-insurance-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/checker-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/checklist-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/review-delivery-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/result-test-environment.ts', 'apps/api/src/application.ts'],
  ['scripts/p3-mixed-preview.ts', 'apps/api/src/application.ts'],
  ['scripts/p3-intake-ui-preview.ts', 'apps/web/src/draft-chat.ts'],
]);
const nativeEnvironment = 'packages/server/src/experiments/p0/persistence/environment.ts';
const slash = value => value.split(sep).join('/');
const inside = (directory, file) => file === directory || file.startsWith(`${directory}${sep}`);
const experiment = file => /(?:^|\/)experiments\/p0(?:[./]|$)/.test(file);
const experimentSource = file => /^(?:packages\/(?:server|workflows)\/src\/experiments\/p0\/|apps\/(?:api|worker)\/src\/experiments\/p0\.ts$)/.test(file);
const literal = node => node && [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.kind) ? node.text : undefined;
const identifier = (node, name) => node?.kind === SyntaxKind.Identifier && node.text === name;

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return excludedDirectories.has(entry.name) ? [] : filesIn(file);
    return entry.isFile() && sourceExtensions.test(entry.name) ? [file] : [];
  });
}

function workspaces(root) {
  return ['apps', 'packages'].flatMap(group => {
    const directory = resolve(root, group);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const directory = resolve(root, group, entry.name), manifest = resolve(directory, 'package.json');
      if (!existsSync(manifest)) return [];
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      return [{ directory, manifest, ...data }];
    });
  });
}

function exportedTargets(exports, subpath) {
  const entry = typeof exports === 'string' || exports === null || Array.isArray(exports)
    ? subpath === '.' ? exports : undefined
    : exports && Object.keys(exports).some(key => key.startsWith('.')) ? exports[subpath]
      : subpath === '.' ? exports : undefined;
  const targets = value => typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
  return targets(entry);
}

// This is the only package-to-repository dynamic loader. Its AST, destination,
// and source file are fixed; moving the call into formal code is not allowed.
function isNativeEnvironmentImport(file, argument) {
  if (file !== nativeEnvironment || argument?.kind !== SyntaxKind.PropertyAccessExpression || !identifier(argument.name, 'href')) return false;
  const url = argument.expression;
  if (url?.kind !== SyntaxKind.CallExpression || !identifier(url.expression, 'pathToFileURL') || url.arguments.length !== 1) return false;
  const path = url.arguments[0];
  return path?.kind === SyntaxKind.CallExpression && identifier(path.expression, 'resolve') && path.arguments.length === 1 && literal(path.arguments[0]) === 'infra/dev/p0-native.mjs';
}

/** Inspect syntax without resolving or executing application modules. */
export function checkWorkspaceBoundaries(rootDirectory) {
  const root = resolve(rootDirectory), packages = workspaces(root);
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const files = ['apps', 'packages', 'scripts', 'infra', 'test'].flatMap(directory => filesIn(resolve(root, directory))).sort();
  const violations = [];
  let importsChecked = 0;
  const owner = file => packages.find(pkg => inside(pkg.directory, file));
  const report = (file, code, specifier, line = 1, column = 1) => violations.push({ file: slash(relative(root, file)), line, column, code, specifier });
  const allowed = (from, to) => from.name === to.name || dependencyDirections.get(from.name)?.includes(to.name);
  for (const pkg of packages) {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const dependency = byName.get(name);
      if (dependency && !allowed(pkg, dependency)) report(pkg.manifest, 'dependency_direction', name);
    }
  }
  if (!files.length) return { filesChecked: 0, importsChecked, violations };
  // The virtual project uses the repository's pinned TS7 parser, never a global
  // TypeScript install. noResolve ensures missing imports cannot hide a file.
  const configFile = resolve(root, '.workspace-boundaries.virtual.json');
  const config = JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, allowJs: true, jsx: 'preserve', target: 'esnext' }, files });
  const api = new API({ cwd: root, fs: {
    fileExists: file => file === configFile ? true : undefined,
    readFile: file => file === configFile ? config : undefined,
  } });
  let snapshot;
  try {
    api.parseConfigFile(configFile);
    snapshot = api.updateSnapshot({ openProjects: [configFile] });
    const program = snapshot.getProject(configFile).program;
    for (const file of files) {
      const source = program.getSourceFile(file), from = owner(file), localFile = slash(relative(root, file));
      if (!source) { report(file, 'source_not_parsed', ''); continue; }
      if (!from && /^(?:apps|packages)\//.test(localFile)) report(file, 'source_outside_workspace', 'package.json required');
      for (const diagnostic of program.getSyntacticDiagnostics(file)) report(file, 'invalid_syntax', String(diagnostic.code));
      const formal = from && from.name !== '@hsbc/testing' && !experimentSource(localFile);
      const rootTest = localFile.startsWith('test/');
      const position = node => {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        return [line + 1, character + 1];
      };
      function check(node, argument, dynamic = false) {
        importsChecked++;
        const specifier = literal(argument), location = position(node);
        if (specifier === undefined) {
          if (from && dynamic && !isNativeEnvironmentImport(localFile, argument)) report(file, 'nonliteral_module', '<dynamic>', ...location);
          return;
        }
        const workspaceName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        const to = byName.get(workspaceName);
        if (to || specifier.startsWith('@hsbc/')) {
          if (!to) { report(file, 'unknown_workspace', specifier, ...location); return; }
          const subpath = specifier === workspaceName ? '.' : `.${specifier.slice(workspaceName.length)}`;
          const targets = exportedTargets(to.exports, subpath);
          if (!targets.length || targets.some(target => !target.startsWith('./') || !inside(to.directory, resolve(to.directory, target)) || !existsSync(resolve(to.directory, target)))) {
            report(file, 'unexported_subpath', specifier, ...location);
          }
          if (formal && (to.name === '@hsbc/testing' || experiment(specifier) || targets.some(experiment))) report(file, 'formal_experiment_dependency', specifier, ...location);
          if (from && from !== to) {
            if (!allowed(from, to)) report(file, 'dependency_direction', specifier, ...location);
            if (!(to.name in { ...from.dependencies, ...from.optionalDependencies, ...from.peerDependencies })) report(file, 'undeclared_workspace_dependency', specifier, ...location);
          }
          return;
        }
        let target;
        if (specifier.startsWith('.')) target = resolve(dirname(file), specifier);
        else if (isAbsolute(specifier)) target = resolve(specifier);
        else if (specifier.startsWith('file:')) { try { target = fileURLToPath(specifier); } catch { report(file, 'invalid_file_module', specifier, ...location); } }
        if (!target) {
          const dependencies = { ...from?.dependencies, ...from?.optionalDependencies, ...from?.peerDependencies,
            ...(!from || !inside(resolve(from.directory, 'src'), file) ? from?.devDependencies : {}) };
          if (from && !isBuiltin(specifier) && !(workspaceName in dependencies)) report(file, 'undeclared_external_dependency', specifier, ...location);
          return;
        }
        const toPackage = owner(target), localTarget = slash(relative(root, target));
        if (formal && experiment(localTarget)) report(file, 'formal_experiment_dependency', specifier, ...location);
        // Root unit/integration tests deliberately exercise private functions.
        // This exception does not apply to production colocated *.test files.
        if (rootTest || previewEntries.get(localFile) === localTarget.replace(/\.js$/, '.ts')) return;
        if (toPackage && toPackage !== from) report(file, 'cross_package_relative', specifier, ...location);
        else if (from && !inside(from.directory, target)) report(file, 'package_escape', specifier, ...location);
      }
      const requireFactories = new Set(['createRequire']);
      const requireNames = new Set(['require']);
      const gather = node => {
        if (node.kind === SyntaxKind.ImportDeclaration && ['node:module', 'module'].includes(literal(node.moduleSpecifier))) {
          for (const binding of node.importClause?.namedBindings?.elements ?? []) if ((binding.propertyName ?? binding.name).text === 'createRequire') requireFactories.add(binding.name.text);
        }
        if (node.kind === SyntaxKind.VariableDeclaration && node.name.kind === SyntaxKind.Identifier && node.initializer?.kind === SyntaxKind.CallExpression && requireFactories.has(node.initializer.expression.text)) requireNames.add(node.name.text);
        node.forEachChild(gather);
      };
      gather(source);
      const requireFactoryCall = node => node?.kind === SyntaxKind.CallExpression && requireFactories.has(node.expression.text);
      const requireExpression = node => (node?.kind === SyntaxKind.Identifier && requireNames.has(node.text)) || requireFactoryCall(node);
      const visit = node => {
        if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration) {
          if (node.moduleSpecifier) check(node, node.moduleSpecifier);
        } else if (node.kind === SyntaxKind.ImportEqualsDeclaration && node.moduleReference.kind === SyntaxKind.ExternalModuleReference) {
          check(node, node.moduleReference.expression);
        } else if (node.kind === SyntaxKind.ImportType) {
          check(node, node.argument?.literal);
        } else if (node.kind === SyntaxKind.CallExpression) {
          const expression = node.expression;
          const directRequire = requireExpression(expression);
          const propertyRequire = expression.kind === SyntaxKind.PropertyAccessExpression &&
            ((identifier(expression.expression, 'module') && identifier(expression.name, 'require')) ||
             (requireExpression(expression.expression) && identifier(expression.name, 'resolve')));
          if (expression.kind === SyntaxKind.ImportKeyword || directRequire || propertyRequire) check(node, node.arguments[0], true);
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  } finally {
    snapshot?.dispose();
    api.close();
  }
  return { filesChecked: files.length, importsChecked, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkWorkspaceBoundaries(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  for (const violation of result.violations) console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.code}: ${violation.specifier}`);
  console.log(`Workspace boundaries: ${result.filesChecked} files, ${result.importsChecked} imports, ${result.violations.length} violations.`);
  if (result.violations.length) process.exitCode = 1;
}
