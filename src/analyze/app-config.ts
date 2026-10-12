import { CallExpression, ClassDeclaration, Node, SyntaxKind } from 'ts-morph';
import { Callable, Ctx, isFunctionNode, literalList, literalText, locOf, objectProp, oneLine, resolveClass, resolveIdentifier, trunc, unwrap } from '../project';

/** A guard / pipe / interceptor / filter / middleware as written in the source. */
export interface Ref {
  name: string;
  cls?: ClassDeclaration;
  /** An inline function, e.g. `app.use((req, res, next) => ...)`. */
  fn?: Callable;
  /** The `new X(...)` expression, when the ref is an instance (wrappers such as `trace(new X())` removed). */
  instance?: Node;
  node: Node;
}

export type MwTarget =
  | { kind: 'all' }
  | { kind: 'path'; path: string; method?: string }
  | { kind: 'controller'; cls: ClassDeclaration }
  | { kind: 'unknown'; text: string };

export interface ModuleMiddleware {
  refs: Ref[];
  targets: MwTarget[];
  excludes: MwTarget[];
  module: string;
}

export interface AppConfig {
  globalPrefix?: string;
  /** Routes that `setGlobalPrefix(..., { exclude })` leaves without the prefix. */
  prefixExclude: { path: string; method?: string }[];
  versioning?: { type: string; prefix: string; defaultVersion: string[]; neutralDefault?: boolean };
  middleware: Ref[];
  guards: Ref[];
  interceptors: Ref[];
  pipes: Ref[];
  filters: Ref[];
  moduleMiddleware: ModuleMiddleware[];
  warnings: string[];
}

export function parseRef(ctx: Ctx, node: Node): Ref {
  const n = unwrap(node);
  if (Node.isIdentifier(n)) return { name: n.getText(), cls: resolveClass(ctx, n), node };
  if (Node.isNewExpression(n)) {
    const args = n.getArguments().map((a) => oneLine(a.getText())).join(', ');
    return { name: n.getExpression().getText() + (args ? `(${trunc(args, 60)})` : ''), cls: resolveClass(ctx, n.getExpression()), instance: n, node };
  }
  if (isFunctionNode(n)) {
    const loc = locOf(ctx, n);
    return { name: `inline function (${loc.file.split('/').pop()}:${loc.line})`, fn: n, node };
  }
  if (Node.isCallExpression(n)) {
    const args = n.getArguments().map(unwrap);
    // `traceInstanceMethod(new I18nValidationPipe(...))`: a wrapper around an instance keeps the instance's identity.
    const inst = args.find((a) => Node.isNewExpression(a));
    if (inst) return { ...parseRef(ctx, inst), node };
    // `traceMiddleware('HttpMiddleware.csrf', (req, res, next) => ...)` or `traceMiddleware('x', helmet())`:
    // a labelled wrapper; the wrapped function is what runs.
    const label = args.map((a) => literalText(a)).find((t) => t !== undefined);
    const fn = args.find((a) => isFunctionNode(a));
    if (label !== undefined && fn) return { ...parseRef(ctx, fn), name: label, node };
    const call = args.find((a) => Node.isCallExpression(a));
    if (label !== undefined && call) return { ...parseRef(ctx, call), node };
  }
  return { name: trunc(n.getText(), 50), node };
}

const PROVIDER_TOKENS: Record<string, 'guards' | 'pipes' | 'interceptors' | 'filters'> = {
  APP_GUARD: 'guards',
  APP_PIPE: 'pipes',
  APP_INTERCEPTOR: 'interceptors',
  APP_FILTER: 'filters',
};

const GLOBAL_METHODS: Record<string, 'guards' | 'pipes' | 'interceptors' | 'filters' | 'middleware'> = {
  useGlobalGuards: 'guards',
  useGlobalPipes: 'pipes',
  useGlobalInterceptors: 'interceptors',
  useGlobalFilters: 'filters',
  use: 'middleware',
};

interface Bootstrap {
  file: string;
  /** Calls on the app object, including those made inside helpers the app is passed to. */
  calls: { method: string; args: Node[] }[];
  listens: boolean;
}

/** Reads everything that applies to all routes: bootstrap calls, APP_* providers, module middleware. */
export function readAppConfig(ctx: Ctx): AppConfig {
  const cfg: AppConfig = { prefixExclude: [], middleware: [], guards: [], interceptors: [], pipes: [], filters: [], moduleMiddleware: [], warnings: [] };

  // 1. Bootstrap file(s): const app = await NestFactory.create(...)
  const found: Bootstrap[] = [];
  for (const sf of ctx.files) {
    if (!sf.getFullText().includes('NestFactory')) continue;
    for (const d of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = d.getInitializer();
      const u = init ? unwrap(init) : undefined;
      if (!u || !Node.isCallExpression(u) || !/NestFactory\.create(Microservice)?$/.test(u.getExpression().getText())) continue;
      const scope = d.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isMethodDeclaration(a)) ?? sf;
      const calls = appCalls(ctx, scope, d.getName(), 0);
      found.push({ file: sf.getFilePath(), calls, listens: calls.some((c) => c.method === 'listen') });
    }
  }
  // Seed scripts and CLIs also create an app, but only the HTTP app listens.
  const listening = found.filter((b) => b.listens);
  const apps = listening.length ? listening : found;
  const files = new Set(apps.map((b) => b.file));
  if (files.size > 1) {
    cfg.warnings.push(`Found ${files.size} files that start an app with NestFactory.create; their global settings were merged. Point the tool at one app if this is a monorepo.`);
  }
  if (!found.length) {
    cfg.warnings.push('No NestFactory.create call found, so global prefix, versioning and global pipes/guards from main.ts are unknown.');
  }
  for (const { calls } of apps) {
    for (const { method, args } of calls) {
      if (method === 'setGlobalPrefix') readPrefix(cfg, args);
      else if (method === 'enableVersioning') {
        const type = objectProp(args[0], 'type')?.getText().split('.').pop() ?? 'URI';
        const prefixNode = objectProp(args[0], 'prefix');
        const prefix = prefixNode ? (prefixNode.getText() === 'false' ? '' : literalText(prefixNode) ?? 'v') : 'v';
        const def = objectProp(args[0], 'defaultVersion');
        cfg.versioning = { type, prefix, defaultVersion: literalList(def), neutralDefault: !!def && /VERSION_NEUTRAL/.test(def.getText()) };
      } else if (GLOBAL_METHODS[method]) {
        cfg[GLOBAL_METHODS[method]].push(...args.map((a) => parseRef(ctx, a)));
      }
    }
  }

  // 2. Modules: APP_* providers and consumer.apply(...).forRoutes(...). Nest registers APP_* providers while
  // creating the app, before main.ts calls useGlobal*, so they run first.
  const provided: Pick<AppConfig, 'guards' | 'pipes' | 'interceptors' | 'filters'> = { guards: [], pipes: [], interceptors: [], filters: [] };
  for (const cls of ctx.classes) {
    const moduleDec = cls.getDecorator('Module');
    if (!moduleDec) continue;
    const providers = objectProp(moduleDec.getArguments()[0], 'providers');
    if (providers && Node.isArrayLiteralExpression(providers)) {
      for (const el of providers.getElements()) {
        const token = objectProp(el, 'provide')?.getText() ?? '';
        const bucket = PROVIDER_TOKENS[token];
        if (!bucket) continue;
        const value = objectProp(el, 'useClass') ?? objectProp(el, 'useExisting') ?? objectProp(el, 'useValue');
        const factory = objectProp(el, 'useFactory');
        if (value) provided[bucket].push(parseRef(ctx, value));
        else if (factory) provided[bucket].push({ name: `factory: ${trunc(factory.getText(), 40)}`, node: factory });
      }
    }

    const configure = cls.getInstanceMethod('configure');
    const consumer = configure?.getParameters()[0]?.getName();
    if (!configure || !consumer) continue;
    for (const call of configure.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'forRoutes') continue;
      const links = chainCalls(call);
      if (links.root !== consumer) continue;
      // In `apply(A).forRoutes(x).apply(B).forRoutes(y)` each forRoutes belongs to the nearest apply before it.
      const at = links.calls.length - 1;
      let from = -1;
      for (let i = at - 1; i >= 0; i--) {
        if (links.calls[i].name === 'apply') {
          from = i;
          break;
        }
      }
      if (from < 0) continue;
      cfg.moduleMiddleware.push({
        refs: links.calls[from].call.getArguments().map((a) => parseRef(ctx, a)),
        targets: call.getArguments().map((a) => parseTarget(ctx, a)),
        excludes: links.calls
          .slice(from + 1, at)
          .filter((c) => c.name === 'exclude')
          .flatMap((c) => c.call.getArguments().map((a) => parseTarget(ctx, a))),
        module: cls.getName() ?? 'module',
      });
    }
  }
  for (const bucket of ['guards', 'pipes', 'interceptors', 'filters'] as const) cfg[bucket] = [...provided[bucket], ...cfg[bucket]];
  return cfg;
}

/** Calls made on `app`, following helpers that receive it (`setup(app)`), a few levels deep. */
function appCalls(ctx: Ctx, scope: Node, appName: string, depth: number): { method: string; args: Node[] }[] {
  const out: { method: string; args: Node[] }[] = [];
  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === appName) {
      out.push({ method: callee.getName(), args: call.getArguments() });
      continue;
    }
    if (depth >= 3) continue;
    const index = call.getArguments().findIndex((a) => a.getText() === appName);
    if (index < 0 || !Node.isIdentifier(callee)) continue;
    const decl = resolveIdentifier(ctx, callee);
    const fn = decl && Node.isFunctionDeclaration(decl) ? decl : decl && Node.isVariableDeclaration(decl) && isFunctionNode(decl.getInitializer()) ? decl.getInitializer() : undefined;
    if (!fn || !(Node.isFunctionDeclaration(fn) || isFunctionNode(fn))) continue;
    const param = fn.getParameters()[index]?.getName();
    const body = fn.getBody();
    if (param && body) out.push(...appCalls(ctx, body, param, depth + 1));
  }
  return out;
}

function readPrefix(cfg: AppConfig, args: Node[]) {
  const arg = args[0];
  const literal = literalText(arg);
  if (literal !== undefined) cfg.globalPrefix = literal;
  else if (arg) {
    // `process.env.API_PREFIX ?? 'api'`: only the fallback is known statically.
    const u = unwrap(arg);
    const fallback = Node.isBinaryExpression(u) && /^(\?\?|\|\|)$/.test(u.getOperatorToken().getText()) ? literalText(u.getRight()) : undefined;
    if (fallback !== undefined) {
      cfg.globalPrefix = fallback;
      cfg.warnings.push(`The global prefix is \`${trunc(arg.getText(), 60)}\`; paths use its fallback '${fallback}'.`);
    } else {
      cfg.warnings.push(`The global prefix \`${trunc(arg.getText(), 60)}\` is computed at runtime, so paths are shown without it.`);
    }
  }
  const exclude = objectProp(args[1], 'exclude');
  const list = exclude ? unwrap(exclude) : undefined;
  if (list && Node.isArrayLiteralExpression(list)) {
    for (const el of list.getElements()) {
      const path = literalText(el) ?? literalText(objectProp(el, 'path'));
      const method = objectProp(el, 'method')?.getText().split('.').pop();
      if (path !== undefined) cfg.prefixExclude.push({ path, method: method && method !== 'ALL' ? method : undefined });
    }
  }
}

function chainCalls(call: CallExpression): { root: string; calls: { name: string; call: CallExpression }[] } {
  const calls: { name: string; call: CallExpression }[] = [];
  let cur: Node = call;
  while (Node.isCallExpression(cur)) {
    const callee: Node = cur.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    calls.unshift({ name: callee.getName(), call: cur });
    cur = callee.getExpression();
  }
  return { root: cur.getText(), calls };
}

const ALL_PATHS = /^\/?(\*\w*|\(\.\*\)|\{\*\w+\})$/;

function parseTarget(ctx: Ctx, node: Node): MwTarget {
  const n = unwrap(node);
  const text = literalText(n);
  if (text !== undefined) {
    if (ALL_PATHS.test(text)) return { kind: 'all' };
    return { kind: 'path', path: text };
  }
  if (Node.isIdentifier(n)) {
    const cls = resolveClass(ctx, n);
    if (cls?.getDecorator('Controller')) return { kind: 'controller', cls };
  }
  if (Node.isObjectLiteralExpression(n)) {
    const path = literalText(objectProp(n, 'path'));
    const method = objectProp(n, 'method')?.getText().split('.').pop();
    if (path !== undefined) {
      if (ALL_PATHS.test(path) && (!method || method === 'ALL')) return { kind: 'all' };
      return { kind: 'path', path, method: method && method !== 'ALL' ? method : undefined };
    }
  }
  return { kind: 'unknown', text: trunc(n.getText(), 40) };
}

/** A Nest route pattern (`users/:id`, `auth/(.*)`, `auth/*splat`, `auth/{*splat}`) as an anchored regex body. */
export function pathPattern(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => {
      if (/^(\(\.\*\)|\*\w*|\{\*\w+\})$/.test(seg)) return '.*';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    })
    .join('/');
}

/** Does a module-middleware target cover this route? `prefix` means it matched as a path prefix. */
export function targetMatches(t: MwTarget, route: { controller: ClassDeclaration; method: string; paths: string[] }): 'yes' | 'prefix' | 'maybe' | 'no' {
  if (t.kind === 'all') return 'yes';
  if (t.kind === 'controller') return t.cls === route.controller ? 'yes' : 'no';
  if (t.kind === 'unknown') return 'maybe';
  if (t.method && t.method !== route.method) return 'no';
  const source = pathPattern(t.path);
  for (const p of route.paths.map((x) => x.replace(/^\/+|\/+$/g, ''))) {
    if (new RegExp(`^${source}$`).test(p)) return 'yes';
    if (source !== '' && new RegExp(`^${source}/`).test(p)) return 'prefix';
  }
  return 'no';
}
