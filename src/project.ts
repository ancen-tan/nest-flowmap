import * as fs from 'fs';
import * as path from 'path';
import {
  ArrowFunction,
  ClassDeclaration,
  Decorator,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  InterfaceDeclaration,
  MethodDeclaration,
  Node,
  Project,
  SourceFile,
  TypeNode,
} from 'ts-morph';
import { HTTP_STATUS } from './http';
import { Layer, Loc } from './model';

export interface Options {
  /** How many nested calls to follow from a handler before stopping. */
  depth: number;
  /** Also draw statements that are neither a branch, a call nor a database operation. */
  verbose: boolean;
}

export interface Ctx {
  project: Project;
  root: string;
  opts: Options;
  files: SourceFile[];
  classes: ClassDeclaration[];
  classIndex: Map<string, ClassDeclaration[]>;
  interfaceImpls: Map<string, ClassDeclaration[]>;
  depsCache: Map<ClassDeclaration, Map<string, Dep>>;
}

export type Callable = MethodDeclaration | FunctionDeclaration | ArrowFunction | FunctionExpression;

export type DepKind =
  | 'class'
  | 'repo'
  | 'manager'
  | 'datasource'
  | 'queue'
  | 'events'
  | 'http'
  | 'client'
  | 'ignore'
  | 'unknown';

export interface Dep {
  name: string;
  typeText: string;
  kind: DepKind;
  cls?: ClassDeclaration;
  entity?: ClassDeclaration;
  queue?: string;
  note?: string;
}

const TEST_FILE = /\.(spec|test|e2e-spec)\.ts$|(^|[\\/])(test|tests|__tests__|__mocks__)[\\/]/;

export function loadProject(root: string, opts: Options, tsconfig?: string): Ctx {
  const candidates = tsconfig
    ? [path.resolve(tsconfig)]
    : ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.build.json'].map((f) => path.join(root, f));
  const tsPath = candidates.find((f) => fs.existsSync(f));
  if (tsconfig && !tsPath) throw new Error(`tsconfig not found: ${tsconfig}`);

  const project = tsPath
    ? new Project({ tsConfigFilePath: tsPath })
    : new Project({ compilerOptions: { experimentalDecorators: true } });
  const inRoot = (sf: SourceFile) => !path.relative(root, sf.getFilePath()).startsWith('..');
  if (!project.getSourceFiles().some((sf) => inRoot(sf) && !sf.isDeclarationFile())) {
    project.addSourceFilesAtPaths([path.join(root, 'src/**/*.ts').replace(/\\/g, '/')]);
  }

  const files = project
    .getSourceFiles()
    .filter((sf) => !sf.isInNodeModules() && !sf.isDeclarationFile() && !TEST_FILE.test(path.relative(root, sf.getFilePath())))
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));

  const classes: ClassDeclaration[] = [];
  const classIndex = new Map<string, ClassDeclaration[]>();
  const interfaceImpls = new Map<string, ClassDeclaration[]>();
  for (const sf of files) {
    for (const cls of sf.getClasses()) {
      classes.push(cls);
      const name = cls.getName();
      if (name) push(classIndex, name, cls);
      for (const impl of cls.getImplements()) {
        push(interfaceImpls, impl.getExpression().getText(), cls);
      }
    }
  }
  return { project, root, opts, files, classes, classIndex, interfaceImpls, depsCache: new Map() };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------------------------
// Text helpers

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function trunc(s: string, n = 60): string {
  const t = oneLine(s);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

export function locOf(ctx: Ctx, node: Node): Loc {
  const file = path.relative(ctx.root, node.getSourceFile().getFilePath()).replace(/\\/g, '/');
  return { file, line: node.getStartLineNumber() };
}

export function unwrap(node: Node): Node {
  let n = node;
  for (;;) {
    if (
      Node.isAsExpression(n) ||
      Node.isParenthesizedExpression(n) ||
      Node.isNonNullExpression(n) ||
      Node.isAwaitExpression(n) ||
      Node.isTypeAssertion(n) ||
      Node.isSatisfiesExpression(n)
    ) {
      n = n.getExpression();
    } else {
      return n;
    }
  }
}

/** The value of a string or number literal, following `as const` and constants the checker can resolve. */
export function literalText(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const n = unwrap(node);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
  if (Node.isNumericLiteral(n)) return n.getText();
  try {
    const t = n.getType();
    if (t.isStringLiteral() || t.isNumberLiteral()) return String(t.getLiteralValue());
  } catch {
    /* unresolved type */
  }
  return constantText(n, 0);
}

/**
 * Follows `NAME` / `OBJ.KEY` to its declaration and reads the initializer, for constants whose
 * type is widened to `string` (e.g. `export const QUEUES = { MAIL: 'mail' }` without `as const`).
 */
function constantText(n: Node, depth: number): string | undefined {
  if (depth > 5 || !(Node.isIdentifier(n) || Node.isPropertyAccessExpression(n))) return undefined;
  try {
    let sym = n.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol();
    for (const decl of sym?.getDeclarations() ?? []) {
      if (Node.isEnumMember(decl)) {
        const v = decl.getValue();
        if (v !== undefined) return String(v);
        continue;
      }
      let init: Node | undefined;
      if (Node.isPropertyAssignment(decl)) init = decl.getInitializer();
      else if (Node.isVariableDeclaration(decl) && decl.getVariableStatement()?.getDeclarationKind() === 'const') {
        init = decl.getInitializer();
      }
      if (!init) continue;
      const u = unwrap(init);
      if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) return u.getLiteralText();
      if (Node.isNumericLiteral(u)) return u.getText();
      const v = constantText(u, depth + 1);
      if (v !== undefined) return v;
    }
  } catch {
    /* unresolved symbol */
  }
  return undefined;
}

export function literalList(node: Node | undefined): string[] {
  if (!node) return [];
  const n = unwrap(node);
  if (Node.isArrayLiteralExpression(n)) {
    return n.getElements().flatMap((e) => literalList(e));
  }
  const v = literalText(n);
  return v === undefined ? [] : [v];
}

/** Reads a status given as a number or as `HttpStatus.X`. */
export function statusOf(node: Node | undefined): number | undefined {
  if (!node) return undefined;
  const n = unwrap(node);
  if (Node.isNumericLiteral(n)) return Number(n.getText());
  if (Node.isPropertyAccessExpression(n)) {
    const code = HTTP_STATUS[n.getName()];
    if (code) return code;
  }
  const lit = literalText(n);
  return lit && /^\d{3}$/.test(lit) ? Number(lit) : undefined;
}

export function decoratorArgs(d: Decorator | undefined): Node[] {
  return d ? d.getArguments() : [];
}

export function objectProp(node: Node | undefined, name: string): Node | undefined {
  if (!node) return undefined;
  const n = unwrap(node);
  if (!Node.isObjectLiteralExpression(n)) return undefined;
  const p = n.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

export function isFunctionNode(n: Node | undefined): n is ArrowFunction | FunctionExpression {
  return !!n && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));
}

// ---------------------------------------------------------------------------------------------
// Symbol resolution (type checker first, class-name index as a fallback so the tool still works
// when node_modules is missing or a type cannot be resolved)

function isProjectNode(node: Node): boolean {
  const sf = node.getSourceFile();
  return !sf.isInNodeModules() && !sf.isDeclarationFile();
}

export function resolveIdentifier(ctx: Ctx, id: Node | undefined): Node | undefined {
  if (!id || !Node.isIdentifier(id)) return undefined;
  try {
    let sym = (id as Identifier).getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    for (const d of sym?.getDeclarations() ?? []) {
      if (!isProjectNode(d)) continue;
      if (
        Node.isClassDeclaration(d) ||
        Node.isInterfaceDeclaration(d) ||
        Node.isFunctionDeclaration(d) ||
        Node.isVariableDeclaration(d) ||
        Node.isEnumDeclaration(d)
      ) {
        return d;
      }
    }
  } catch {
    /* fall through to the name index */
  }
  const byName = ctx.classIndex.get(id.getText());
  return byName?.length === 1 ? byName[0] : undefined;
}

export function resolveClass(ctx: Ctx, id: Node | undefined): ClassDeclaration | undefined {
  const d = resolveIdentifier(ctx, id);
  return d && Node.isClassDeclaration(d) ? d : undefined;
}

function typeNameIdentifier(typeNode: TypeNode | undefined): Identifier | undefined {
  if (!typeNode || !Node.isTypeReference(typeNode)) return undefined;
  const name = typeNode.getTypeName();
  return Node.isIdentifier(name) ? name : name.getRight();
}

export function resolveTypeNode(ctx: Ctx, typeNode: TypeNode | undefined): ClassDeclaration | InterfaceDeclaration | undefined {
  const d = resolveIdentifier(ctx, typeNameIdentifier(typeNode));
  return d && (Node.isClassDeclaration(d) || Node.isInterfaceDeclaration(d)) ? d : undefined;
}

export function baseClass(ctx: Ctx, cls: ClassDeclaration): ClassDeclaration | undefined {
  const ext = cls.getExtends();
  if (!ext) return undefined;
  const base = resolveClass(ctx, ext.getExpression());
  return base && base !== cls ? base : undefined;
}

/** The class and its project-defined ancestors, nearest first. */
export function lineage(ctx: Ctx, cls: ClassDeclaration): ClassDeclaration[] {
  const out: ClassDeclaration[] = [];
  let c: ClassDeclaration | undefined = cls;
  while (c && !out.includes(c)) {
    out.push(c);
    c = baseClass(ctx, c);
  }
  return out;
}

export function findCallable(
  ctx: Ctx,
  cls: ClassDeclaration,
  name: string,
  from: 'self' | 'base' = 'self',
): { fn: Callable; owner: ClassDeclaration } | undefined {
  const chain = lineage(ctx, cls).slice(from === 'base' ? 1 : 0);
  for (const c of chain) {
    const m = c.getInstanceMethod(name) ?? c.getStaticMethod(name);
    if (m && m.getBody()) return { fn: m, owner: c };
    const p = c.getInstanceProperty(name);
    if (p && Node.isPropertyDeclaration(p)) {
      const init = p.getInitializer();
      if (isFunctionNode(init)) return { fn: init, owner: c };
    }
  }
  return undefined;
}

/** `Repository<User>` in an `extends` clause or a type annotation: returns the User class. */
export function repositoryEntity(ctx: Ctx, cls: ClassDeclaration): ClassDeclaration | undefined {
  for (const c of lineage(ctx, cls)) {
    const ext = c.getExtends();
    if (ext && /Repository$/.test(ext.getExpression().getText())) {
      const arg = ext.getTypeArguments()[0];
      const entity = resolveTypeNode(ctx, arg);
      if (entity && Node.isClassDeclaration(entity)) return entity;
    }
  }
  return undefined;
}

export function classLayer(ctx: Ctx, cls: ClassDeclaration): Layer {
  if (cls.getDecorator('Controller')) return 'controller';
  if (cls.getDecorator('Entity')) return 'entity';
  const name = cls.getName() ?? '';
  const ext = cls.getExtends()?.getExpression().getText() ?? '';
  if (/Repository$/.test(ext) || /(Repository|Repo|Dao)$/.test(name)) return 'entity';
  return 'service';
}

// ---------------------------------------------------------------------------------------------
// Injected dependencies

const IGNORED_TYPES = /^(Reflector|ConfigService|ModuleRef|Logger|PinoLogger|LoggerService|ConsoleLogger|ClsService)$/;

function classify(ctx: Ctx, name: string, typeNode: TypeNode | undefined, decorators: Decorator[]): Dep {
  const typeText = typeNode ? oneLine(typeNode.getText()) : '';
  const base = typeText.replace(/<[\s\S]*$/, '').split('.').pop() ?? '';
  const dep: Dep = { name, typeText, kind: 'unknown' };
  const dec = (n: string) => decorators.find((d) => d.getName() === n);

  const injectRepo = dec('InjectRepository');
  if (/^(Repository|TreeRepository|MongoRepository)$/.test(base) || injectRepo) {
    dep.kind = 'repo';
    const typeArg = typeNode && Node.isTypeReference(typeNode) ? typeNode.getTypeArguments()[0] : undefined;
    const fromType = resolveTypeNode(ctx, typeArg);
    dep.entity =
      (fromType && Node.isClassDeclaration(fromType) ? fromType : undefined) ??
      resolveClass(ctx, decoratorArgs(injectRepo)[0]);
    return dep;
  }
  if (/^(EntityManager|QueryRunner)$/.test(base) || dec('InjectEntityManager')) return { ...dep, kind: 'manager' };
  if (/^(DataSource|Connection)$/.test(base) || dec('InjectDataSource')) return { ...dep, kind: 'datasource' };
  const injectQueue = dec('InjectQueue');
  if (base === 'Queue' || injectQueue) {
    return { ...dep, kind: 'queue', queue: literalText(decoratorArgs(injectQueue)[0]) };
  }
  if (/^EventEmitter2?$/.test(base)) return { ...dep, kind: 'events' };
  if (base === 'HttpService') return { ...dep, kind: 'http' };
  if (/^Client(Proxy|Kafka|RMQ|Grpc|Nats|Redis|Mqtt|TCP)$/.test(base)) return { ...dep, kind: 'client' };
  if (IGNORED_TYPES.test(base)) return { ...dep, kind: 'ignore' };

  const decl = resolveTypeNode(ctx, typeNode);
  if (decl && Node.isClassDeclaration(decl)) {
    return { ...dep, kind: 'class', cls: decl, entity: repositoryEntity(ctx, decl) };
  }
  if (decl && Node.isInterfaceDeclaration(decl)) {
    const impls = ctx.interfaceImpls.get(decl.getName()) ?? [];
    if (impls.length === 1) {
      return { ...dep, kind: 'class', cls: impls[0], note: `implements ${decl.getName()}` };
    }
    dep.note =
      impls.length === 0
        ? `no class implements ${decl.getName()}`
        : `${impls.length} classes implement ${decl.getName()}: ${impls.map((c) => c.getName()).join(', ')}`;
  }
  return dep;
}

const BUILTIN_TYPES = /^(Date|Map|Set|WeakMap|WeakSet|Array|ReadonlyArray|Record|Partial|Required|Readonly|Pick|Omit|Promise|RegExp|Buffer|Error|Function|Object|String|Number|Boolean|URL)$/;

/** Data fields (strings, numbers, dates, literals) are not collaborators worth following. */
function isPlainType(typeNode: TypeNode | undefined): boolean {
  if (!typeNode || !Node.isTypeReference(typeNode)) return true;
  return BUILTIN_TYPES.test(typeNode.getTypeName().getText());
}

function isInjected(decorators: Decorator[]): boolean {
  return decorators.some((d) => /^Inject/.test(d.getName()));
}

/** Everything a class can reach through `this.<name>`: constructor parameter properties and typed fields. */
export function getDeps(ctx: Ctx, cls: ClassDeclaration): Map<string, Dep> {
  const cached = ctx.depsCache.get(cls);
  if (cached) return cached;
  const deps = new Map<string, Dep>();
  ctx.depsCache.set(cls, deps);
  for (const c of lineage(ctx, cls)) {
    for (const ctor of c.getConstructors()) {
      for (const p of ctor.getParameters()) {
        if (!p.isParameterProperty() || deps.has(p.getName())) continue;
        if (isPlainType(p.getTypeNode()) && !isInjected(p.getDecorators())) continue;
        deps.set(p.getName(), classify(ctx, p.getName(), p.getTypeNode(), p.getDecorators()));
      }
    }
    for (const p of c.getInstanceProperties()) {
      if (!Node.isPropertyDeclaration(p) || deps.has(p.getName())) continue;
      if (isFunctionNode(p.getInitializer())) continue;
      const injected = isInjected(p.getDecorators());
      if (isPlainType(p.getTypeNode()) && !injected) continue;
      const dep = classify(ctx, p.getName(), p.getTypeNode(), p.getDecorators());
      if (dep.kind !== 'unknown' || injected) deps.set(p.getName(), dep);
    }
  }
  return deps;
}
