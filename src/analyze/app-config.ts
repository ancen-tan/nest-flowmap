import { CallExpression, ClassDeclaration, Node, SyntaxKind } from 'ts-morph';
import { Ctx, literalList, literalText, objectProp, oneLine, resolveClass, trunc, unwrap } from '../project';

/** A guard / pipe / interceptor / filter / middleware as written in the source. */
export interface Ref {
  name: string;
  cls?: ClassDeclaration;
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
  versioning?: { type: string; prefix: string; defaultVersion: string[] };
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
    return { name: n.getExpression().getText() + (args ? `(${trunc(args, 60)})` : ''), cls: resolveClass(ctx, n.getExpression()), node };
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

/** Reads everything that applies to all routes: bootstrap calls, APP_* providers, module middleware. */
export function readAppConfig(ctx: Ctx): AppConfig {
  const cfg: AppConfig = { middleware: [], guards: [], interceptors: [], pipes: [], filters: [], moduleMiddleware: [], warnings: [] };

  // 1. Bootstrap file(s): const app = await NestFactory.create(...)
  let apps = 0;
  for (const sf of ctx.files) {
    if (!sf.getFullText().includes('NestFactory')) continue;
    const appVars = new Set<string>();
    for (const d of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = d.getInitializer();
      const u = init ? unwrap(init) : undefined;
      if (u && Node.isCallExpression(u) && /NestFactory\.create(Microservice)?$/.test(u.getExpression().getText())) {
        appVars.add(d.getName());
      }
    }
    if (!appVars.size) continue;
    apps++;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || !appVars.has(callee.getExpression().getText())) continue;
      const args = call.getArguments();
      const method = callee.getName();
      if (method === 'setGlobalPrefix') {
        cfg.globalPrefix = literalText(args[0]) ?? `{${trunc(args[0]?.getText() ?? '?', 30)}}`;
      } else if (method === 'enableVersioning') {
        const type = objectProp(args[0], 'type')?.getText().split('.').pop() ?? 'URI';
        const prefixNode = objectProp(args[0], 'prefix');
        const prefix = prefixNode ? (prefixNode.getText() === 'false' ? '' : literalText(prefixNode) ?? 'v') : 'v';
        cfg.versioning = { type, prefix, defaultVersion: literalList(objectProp(args[0], 'defaultVersion')) };
      } else if (GLOBAL_METHODS[method]) {
        cfg[GLOBAL_METHODS[method]].push(...args.map((a) => parseRef(ctx, a)));
      }
    }
  }
  if (apps > 1) {
    cfg.warnings.push(`Found ${apps} files that call NestFactory.create; their global settings were merged. Point the tool at one app if this is a monorepo.`);
  }
  if (apps === 0) {
    cfg.warnings.push('No NestFactory.create call found, so global prefix, versioning and global pipes/guards from main.ts are unknown.');
  }

  // 2. Modules: APP_* providers and consumer.apply(...).forRoutes(...)
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
        if (value) cfg[bucket].push(parseRef(ctx, value));
        else if (factory) cfg[bucket].push({ name: `factory: ${trunc(factory.getText(), 40)}`, node: factory });
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
      const apply = links.calls.find((c) => c.name === 'apply');
      if (!apply) continue;
      cfg.moduleMiddleware.push({
        refs: apply.call.getArguments().map((a) => parseRef(ctx, a)),
        targets: call.getArguments().map((a) => parseTarget(ctx, a)),
        excludes: links.calls.filter((c) => c.name === 'exclude').flatMap((c) => c.call.getArguments().map((a) => parseTarget(ctx, a))),
        module: cls.getName() ?? 'module',
      });
    }
  }
  return cfg;
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

function parseTarget(ctx: Ctx, node: Node): MwTarget {
  const n = unwrap(node);
  const text = literalText(n);
  if (text !== undefined) {
    if (/^\/?(\*\w*|\(\.\*\)|\{\*\w+\})$/.test(text)) return { kind: 'all' };
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
      if (/^\/?(\*\w*|\(\.\*\)|\{\*\w+\})$/.test(path) && (!method || method === 'ALL')) return { kind: 'all' };
      return { kind: 'path', path, method: method && method !== 'ALL' ? method : undefined };
    }
  }
  return { kind: 'unknown', text: trunc(n.getText(), 40) };
}

/** Does a module-middleware target cover this route? `prefix` means it matched as a path prefix. */
export function targetMatches(t: MwTarget, route: { controller: ClassDeclaration; method: string; paths: string[] }): 'yes' | 'prefix' | 'maybe' | 'no' {
  if (t.kind === 'all') return 'yes';
  if (t.kind === 'controller') return t.cls === route.controller ? 'yes' : 'no';
  if (t.kind === 'unknown') return 'maybe';
  if (t.method && t.method !== route.method) return 'no';
  const norm = (p: string) => p.replace(/^\/+|\/+$/g, '');
  const source = norm(t.path)
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')))
    .join('/');
  for (const p of route.paths.map(norm)) {
    if (new RegExp(`^${source}$`).test(p)) return 'yes';
    if (new RegExp(`^${source}/`).test(p)) return 'prefix';
  }
  return 'no';
}
