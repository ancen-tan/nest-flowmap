import { CallExpression, ClassDeclaration, Decorator, MethodDeclaration, Node, SyntaxKind } from 'ts-morph';
import { ROUTE_DECORATORS } from '../http';
import { AppDoc, AuthDoc, EndpointDoc, PipelineItem, Step } from '../model';
import {
  Ctx,
  findCallable,
  isFunctionNode,
  lineage,
  literalList,
  literalText,
  locOf,
  objectProp,
  oneLine,
  resolveIdentifier,
  resolveTypeNode,
  statusOf,
  trunc,
  unwrap,
} from '../project';
import { GraphBuilder, Pending } from '../render/graph';
import { endpointMindmap, flowchart, overviewMindmap } from '../render/mermaid';
import { AppConfig, Ref, parseRef, pathPattern, readAppConfig, targetMatches } from './app-config';
import { describeEntity, isEntity } from './entities';
import { Consumers, FlowWalker, RouteMeta, describeException, newScope } from './flow';
import { getDeps, isPackageImport } from '../project';
import { describeParams } from './validation';

interface Item extends PipelineItem {
  ref?: Ref;
}

const NOT_METADATA =
  /^(Get|Post|Put|Patch|Delete|Options|Head|All|Search|Controller|UseGuards|UseInterceptors|UsePipes|UseFilters|HttpCode|Header|Redirect|Version|Render|Injectable|Api\w*|Process|Processor|OnEvent|Cron|Interval|Timeout|MessagePattern|EventPattern|OnWorkerEvent)$/;
const SWAGGER_STATUS: Record<string, number> = {
  ApiOkResponse: 200,
  ApiCreatedResponse: 201,
  ApiAcceptedResponse: 202,
  ApiNoContentResponse: 204,
  ApiBadRequestResponse: 400,
  ApiUnauthorizedResponse: 401,
  ApiForbiddenResponse: 403,
  ApiNotFoundResponse: 404,
  ApiConflictResponse: 409,
  ApiUnprocessableEntityResponse: 422,
  ApiTooManyRequestsResponse: 429,
  ApiInternalServerErrorResponse: 500,
};
const KNOWN_GUARD_STATUS: Record<string, number> = { ThrottlerGuard: 429 };
type DecoratorKind = 'UseGuards' | 'UseInterceptors' | 'UsePipes' | 'UseFilters';
const VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function analyze(ctx: Ctx, name: string): AppDoc {
  const cfg = readAppConfig(ctx);
  const consumers = indexConsumers(ctx);
  const endpoints: EndpointDoc[] = [];

  const controllers = ctx.classes.filter((c) => c.getDecorator('Controller'));
  const conditional = conditionalControllers(ctx);
  for (const cls of controllers) {
    const list = httpEndpoints(ctx, cfg, consumers, cls);
    // Two controllers with the same class name in different folders get the folder in their group.
    if (controllers.some((c) => c !== cls && c.getName() === cls.getName())) {
      const dir = cls.getSourceFile().getDirectory().getBaseName();
      for (const e of list) e.group = `${e.group} (${dir})`;
    }
    const when = conditional.get(cls);
    if (when) for (const e of list) e.warnings.unshift(`Registered only when ${when}.`);
    endpoints.push(...list);
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || verbRank(a.method) - verbRank(b.method));
  const routes = new Map<string, EndpointDoc[]>();
  for (const e of endpoints) routes.set(`${e.method} ${e.path}`, [...(routes.get(`${e.method} ${e.path}`) ?? []), e]);
  for (const [route, list] of routes) {
    if (list.length < 2) continue;
    const conditional = list.some((e) => e.warnings.some((w) => w.startsWith('Registered only when')));
    for (const e of list) {
      const others = list.filter((o) => o !== e).map((o) => o.handler).join(', ');
      e.warnings.unshift(
        conditional
          ? `${route} is also declared by ${others}; they are registered under different conditions, so only one serves a given configuration.`
          : `${route} is also declared by ${others}; Nest serves only the first one registered, so check which module is loaded.`,
      );
    }
  }
  for (const cls of ctx.classes) endpoints.push(...backgroundEntries(ctx, consumers, cls));

  const used = new Map<string, number>();
  for (const ep of endpoints) {
    const n = (used.get(ep.id) ?? 0) + 1;
    used.set(ep.id, n);
    if (n > 1) ep.id = `${ep.id}-${n}`;
  }

  const pipe = cfg.pipes.find((p) => isValidationPipe(ctx, p));
  return {
    name,
    generator: 'nest-flowmap',
    globalPrefix: cfg.globalPrefix,
    versioning: cfg.versioning ? `${cfg.versioning.type}${cfg.versioning.type === 'URI' ? ` (prefix "${cfg.versioning.prefix}")` : ''}` : undefined,
    validationPipe: pipe?.name,
    endpoints,
    overviewMindmap: overviewMindmap(name, endpoints),
    warnings: cfg.warnings,
  };
}

function verbRank(v: string): number {
  const i = VERB_ORDER.indexOf(v);
  return i < 0 ? 99 : i;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

function joinPath(...parts: (string | undefined)[]): string {
  const segs = parts.map((p) => (p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + segs.join('/');
}

/**
 * The decorator calls a decorator boils down to: `@UseSessionGuard()` defined as
 * `applyDecorators(SetMetadata(...), UseGuards(SessionGuard))` yields both inner calls, in order.
 */
function primitiveCalls(ctx: Ctx, d: Decorator): CallExpression[] {
  const call = d.getCallExpression();
  if (call) return expandCall(ctx, call, 0);
  // `@Foo` where `const Foo = UseGuards(X)`
  const id = d.getNameNode();
  const decl = Node.isIdentifier(id) ? resolveIdentifier(ctx, id) : undefined;
  const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
  return init && Node.isCallExpression(unwrap(init)) ? expandCall(ctx, unwrap(init) as CallExpression, 0) : [];
}

function expandCall(ctx: Ctx, call: CallExpression, depth: number): CallExpression[] {
  const callee = call.getExpression();
  const name = callee.getText();
  if (depth > 4) return [call];
  if (name === 'applyDecorators') {
    return call.getArguments().flatMap((a) => (Node.isCallExpression(unwrap(a)) ? expandCall(ctx, unwrap(a) as CallExpression, depth + 1) : []));
  }
  const decl = Node.isIdentifier(callee) ? resolveIdentifier(ctx, callee) : undefined;
  const fn = decl && Node.isFunctionDeclaration(decl) ? decl : decl && Node.isVariableDeclaration(decl) && isFunctionNode(decl.getInitializer()) ? decl.getInitializer() : undefined;
  if (!fn || !(Node.isFunctionDeclaration(fn) || isFunctionNode(fn))) return [call];
  const body = fn.getBody();
  const returned = body && Node.isBlock(body) ? body.getDescendantsOfKind(SyntaxKind.ReturnStatement).map((r) => r.getExpression()) : [body];
  return returned.flatMap((r) => (r && Node.isCallExpression(unwrap(r)) ? expandCall(ctx, unwrap(r) as CallExpression, depth + 1) : []));
}

/**
 * Guards / interceptors / pipes / filters from a list of decorators, in the order Nest runs them:
 * decorators apply bottom-up and each one appends, so the lowest decorator's entries come first.
 */
function refsOf(ctx: Ctx, node: { getDecorators(): Decorator[] }, kind: DecoratorKind): Ref[] {
  return [...node.getDecorators()]
    .reverse()
    .flatMap((d) => primitiveCalls(ctx, d))
    .filter((c) => c.getExpression().getText() === kind)
    .flatMap((c) => c.getArguments().map((a) => parseRef(ctx, a)));
}

/** Class-level refs, including those inherited from base controller classes (base first). */
function classRefs(ctx: Ctx, cls: ClassDeclaration, kind: DecoratorKind): Ref[] {
  return lineage(ctx, cls).reverse().flatMap((c) => refsOf(ctx, c, kind));
}

/** Decorators whose effect the tool models itself; any other package decorator may set metadata it cannot see. */
const KNOWN_DECORATORS =
  /^(Get|Post|Put|Patch|Delete|Options|Head|All|Search|Sse|Controller|UseGuards|UseInterceptors|UsePipes|UseFilters|HttpCode|Header|Redirect|Version|Render|Injectable|Api\w*|Throttle|SkipThrottle|SetMetadata|applyDecorators)$/;

/**
 * Metadata the route carries, by target: `SetMetadata(KEY, value)` on the method (handler) and on the
 * class and its base classes. Incomplete when a decorator could not be expanded (package decorators,
 * non-literal keys), so guards reading a missing key are not decided from it.
 */
function routeMetadata(ctx: Ctx, cls: ClassDeclaration, method: MethodDeclaration): RouteMeta {
  const meta: RouteMeta = { handler: new Map(), cls: new Map(), complete: true };
  const read = (decorators: Decorator[], into: Map<string, string>) => {
    for (const call of decorators.flatMap((d) => primitiveCalls(ctx, d))) {
      const callee = call.getExpression();
      const name = callee.getText();
      if (name === 'SetMetadata') {
        const key = literalText(call.getArguments()[0]);
        if (key === undefined) meta.complete = false;
        else into.set(key, call.getArguments()[1]?.getText() ?? 'true');
      } else if (!KNOWN_DECORATORS.test(name.split('.').pop() ?? '')) {
        // A decorator that is not a known Nest one and was not expanded (from a package, or built at runtime).
        if (Node.isIdentifier(callee) && (isPackageImport(callee) || resolveIdentifier(ctx, callee))) meta.complete = false;
      }
    }
  };
  read(lineage(ctx, cls).reverse().flatMap((c) => c.getDecorators()), meta.cls);
  read(method.getDecorators(), meta.handler);
  return meta;
}

function isValidationPipe(ctx: Ctx, ref: Ref): boolean {
  if (/ValidationPipe\b/.test(ref.name)) return true;
  return !!ref.cls && lineage(ctx, ref.cls).some((c) => /ValidationPipe$/.test(c.getExtends()?.getExpression().getText() ?? ''));
}

/** The `new X(options)` behind a pipe reference, following `const pipe = new X(...)`. */
function instanceOf(ctx: Ctx, node: Node | undefined): Node | undefined {
  if (!node) return undefined;
  const ref = parseRef(ctx, node);
  if (ref.instance) return ref.instance;
  const u = unwrap(node);
  const decl = Node.isIdentifier(u) ? resolveIdentifier(ctx, u) : undefined;
  return decl && Node.isVariableDeclaration(decl) ? instanceOf(ctx, decl.getInitializer()) : undefined;
}

/** The options a pipe was created with, as text (following `new ValidationPipe(options)` to `const options = {...}`). */
function pipeOptionsText(ctx: Ctx, node: Node | undefined): string | undefined {
  const inst = instanceOf(ctx, node);
  if (!inst || !Node.isNewExpression(inst)) return undefined;
  const opts = inst.getArguments()[0];
  const u = opts ? unwrap(opts) : undefined;
  if (u && Node.isIdentifier(u)) {
    const decl = resolveIdentifier(ctx, u);
    if (decl && Node.isVariableDeclaration(decl)) return decl.getInitializer()?.getText();
  }
  return opts?.getText();
}

/** What a pipe throws when input is invalid, from `errorHttpStatusCode` or `exceptionFactory`. */
function pipeError(ctx: Ctx, node: Node | undefined): { status: number; exception: string; message?: string } | undefined {
  const inst = instanceOf(ctx, node);
  if (!inst || !Node.isNewExpression(inst)) return undefined;
  let opts: Node | undefined = inst.getArguments()[0];
  const u = opts ? unwrap(opts) : undefined;
  if (u && Node.isIdentifier(u)) {
    const decl = resolveIdentifier(ctx, u);
    if (decl && Node.isVariableDeclaration(decl)) opts = decl.getInitializer();
  }
  const factory = objectProp(opts, 'exceptionFactory');
  if (factory && isFunctionNode(unwrap(factory))) {
    const fn = unwrap(factory) as import('ts-morph').ArrowFunction;
    const body = fn.getBody();
    const made = (Node.isBlock(body) ? body.getDescendantsOfKind(SyntaxKind.NewExpression) : body.getDescendantsOfKind(SyntaxKind.NewExpression).concat(Node.isNewExpression(body) ? [body] : []))[0];
    if (made) {
      const info = describeException(ctx, made.getExpression(), made.getArguments());
      if (info.status) return { status: info.status, exception: made.getExpression().getText(), message: info.message };
    }
  }
  const status = statusOf(objectProp(opts, 'errorHttpStatusCode'));
  return status ? { status, exception: status === 400 ? 'BadRequestException' : `HTTP ${status}`, message: undefined } : undefined;
}

/** Controllers whose module is only imported under a condition: class → condition text. */
function conditionalControllers(ctx: Ctx): Map<ClassDeclaration, string> {
  const out = new Map<ClassDeclaration, string>();
  const conditionOf = new Map<ClassDeclaration, string>();
  const scan = (node: Node, owner: string, depth: number) => {
    // A module inside nested ternaries is registered when every enclosing branch is taken.
    for (const id of [...(Node.isIdentifier(node) ? [node] : []), ...node.getDescendantsOfKind(SyntaxKind.Identifier)]) {
      const mod = resolveIdentifier(ctx, id);
      if (!mod || !Node.isClassDeclaration(mod) || !mod.getDecorator('Module')) continue;
      const parts: string[] = [];
      let child: Node = id;
      let p: Node | undefined = id.getParent();
      while (p) {
        if (Node.isConditionalExpression(p)) {
          const text = `\`${trunc(p.getCondition().getText(), 60)}\``;
          if (child === p.getWhenTrue()) parts.unshift(text);
          else if (child === p.getWhenFalse()) parts.unshift(`not ${text}`);
        }
        if (p === node) break;
        child = p;
        p = p.getParent();
      }
      if (parts.length) conditionOf.set(mod, `${parts.join(' and ')} (in ${owner})`);
    }
    // `imports: [...extras]` where `const extras = cond ? [] : [ProdModule]`
    if (depth < 2) {
      for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const decl = resolveIdentifier(ctx, id);
        const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
        if (init) scan(init, owner, depth + 1);
      }
    }
  };
  for (const cls of ctx.classes) {
    const imports = objectProp(cls.getDecorator('Module')?.getArguments()[0], 'imports');
    if (imports) scan(imports, cls.getName() ?? 'module', 0);
  }
  for (const [mod, when] of conditionOf) {
    const list = objectProp(mod.getDecorator('Module')!.getArguments()[0], 'controllers');
    for (const id of list?.getDescendantsOfKind(SyntaxKind.Identifier) ?? []) {
      const c = resolveIdentifier(ctx, id);
      if (c && Node.isClassDeclaration(c)) out.set(c, when);
    }
  }
  return out;
}

/**
 * Exception filters that answer the exceptions they catch with a fixed status: `@Catch(DomainError)`
 * whose `catch()` calls `response.status(422)`. Filters closer to the route win, as in Nest.
 */
function filterRemap(ctx: Ctx, filters: Item[]): ((exception: string) => { status: number; filter: string } | undefined) | undefined {
  const rules: { types: string[]; status: number; filter: string }[] = [];
  for (const f of [...filters].reverse()) {
    const cls = f.ref?.cls;
    const catchFn = cls ? findCallable(ctx, cls, 'catch') : undefined;
    if (!cls || !catchFn) continue;
    const types = (cls.getDecorator('Catch')?.getArguments() ?? []).map((a) => a.getText().split('.').pop() ?? '');
    const statuses = catchFn.fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => Node.isPropertyAccessExpression(c.getExpression()) && /^(status|sendStatus)$/.test((c.getExpression() as any).getName()))
      .map((c) => statusOf(c.getArguments()[0]));
    // Only a single literal status is a remap; `exception.getStatus()` keeps the original.
    if (types.length && statuses.length && statuses.every((x) => x !== undefined && x === statuses[0])) {
      rules.push({ types, status: statuses[0]!, filter: cls.getName() ?? 'filter' });
    }
  }
  if (!rules.length) return undefined;
  return (exception: string) => {
    const name = exception.split('.').pop() ?? '';
    const known = ctx.classIndex.get(name);
    const names = known?.length === 1 ? lineage(ctx, known[0]).flatMap((c) => [c.getName() ?? '', c.getExtends()?.getExpression().getText() ?? '']) : [name];
    const hit = rules.find((r) => r.types.some((t) => names.includes(t)));
    return hit ? { status: hit.status, filter: hit.filter } : undefined;
  };
}

/** Guard and middleware source text, to tell basic, bearer and cookie schemes apart. */
function authSchemeOf(ctx: Ctx, ref: Ref | undefined, name: string): AuthDoc['scheme'] | undefined {
  // The guard's own code and the classes it delegates to (`await this.sessions.verify(req)`).
  const own = ref?.cls ? lineage(ctx, ref.cls) : [];
  const deps = own.flatMap((c) => [...getDeps(ctx, c).values()].map((d) => d.cls).filter((c): c is ClassDeclaration => !!c));
  const text = [name, ...own.map((c) => c.getText()), ...deps.map((c) => c.getText()), ref?.fn?.getText() ?? ''].join('\n');
  if (/basic/i.test(name) || /['"`]Basic\s/.test(text)) return 'basic';
  if (/jwt|bearer/i.test(name) || /['"`]Bearer\s|fromAuthHeaderAsBearerToken|AuthGuard\(\s*['"`]jwt/i.test(text)) return 'bearer';
  if (/session|cookie/i.test(name) || /\.session\b|\.cookies\b/.test(text)) return 'cookie';
  return undefined;
}

function metadataOf(node: { getDecorators(): Decorator[] }): string[] {
  return node
    .getDecorators()
    .filter((d) => !NOT_METADATA.test(d.getName()))
    .map((d) => `@${trunc(d.getText().replace(/^@/, ''), 50)}`);
}

// ---------------------------------------------------------------------------------------------
// Queue processors and event listeners (so producers can name their consumers)

function indexConsumers(ctx: Ctx): Consumers {
  const processors = new Map<string, string[]>();
  const listeners = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const cls of ctx.classes) {
    const proc = cls.getDecorator('Processor');
    if (proc) {
      const arg = proc.getArguments()[0];
      const queue = literalText(arg) ?? literalText(objectProp(arg, 'name'));
      if (queue) add(processors, queue, cls.getName() ?? 'processor');
    }
    for (const m of cls.getInstanceMethods()) {
      for (const d of m.getDecorators()) {
        if (d.getName() !== 'OnEvent') continue;
        for (const event of literalList(d.getArguments()[0])) add(listeners, event, `${cls.getName()}.${m.getName()}()`);
      }
    }
  }
  return { processors, listeners };
}

// ---------------------------------------------------------------------------------------------
// HTTP endpoints

function httpEndpoints(ctx: Ctx, cfg: AppConfig, consumers: Consumers, cls: ClassDeclaration): EndpointDoc[] {
  const out: EndpointDoc[] = [];
  const ctrlArg = cls.getDecorator('Controller')!.getArguments()[0];
  const ctrlObject = ctrlArg && Node.isObjectLiteralExpression(unwrap(ctrlArg));
  const ctrlPaths = literalList(ctrlObject ? objectProp(ctrlArg, 'path') : ctrlArg);
  const ctrlVersionNode = ctrlObject ? objectProp(ctrlArg, 'version') : cls.getDecorator('Version')?.getArguments()[0];

  const seen = new Set<string>();
  for (const owner of lineage(ctx, cls)) {
    for (const method of owner.getInstanceMethods()) {
      if (seen.has(method.getName())) continue;
      // An override without route decorators replaces the method, and its route with it.
      seen.add(method.getName());
      const routes = method.getDecorators().filter((d) => ROUTE_DECORATORS[d.getName()]);
      for (const route of routes) {
        const verb = ROUTE_DECORATORS[route.getName()];
        const arg = route.getArguments()[0];
        let methodPaths = literalList(arg);
        if (!methodPaths.length) methodPaths = [arg ? `{${trunc(arg.getText(), 30)}}` : ''];
        const versionNode = method.getDecorator('Version')?.getArguments()[0] ?? ctrlVersionNode;
        const versionSegs = versionSegments(cfg, versionNode);
        const extra: string[] = [];
        if (route.getName() === 'Sse') extra.push('server-sent events');
        if (!cfg.versioning && versionNode) extra.push(`@Version(${trunc(versionNode.getText(), 20)}) has no effect: versioning is not enabled`);
        for (const { seg, note } of versionSegs) {
          for (const cp of ctrlPaths.length ? ctrlPaths : ['']) {
            for (const mp of methodPaths) {
              const routePath = joinPath(cp, mp);
              const prefix = cfg.prefixExclude.some((x) => (!x.method || x.method === verb) && new RegExp(`^${pathPattern(x.path)}$`).test(routePath.replace(/^\/+/, ''))) ? undefined : cfg.globalPrefix;
              out.push(buildHttp(ctx, cfg, consumers, cls, owner, method, verb, joinPath(prefix, seg, cp, mp), routePath, note ? [...extra, note] : extra));
            }
          }
        }
      }
    }
  }
  return out;
}

/** URI segments for a route's versions (`v1`), or a note for header / media-type versioning. */
function versionSegments(cfg: AppConfig, node: Node | undefined): { seg?: string; note?: string }[] {
  const v = cfg.versioning;
  if (!v) return [{}];
  const neutral = node ? /VERSION_NEUTRAL/.test(node.getText()) : v.neutralDefault;
  const versions = node ? literalList(node) : v.defaultVersion;
  if (!versions.length) return [{}];
  if (v.type !== 'URI') return [{ note: `version ${versions.join(', ')} selected by ${v.type}` }];
  const segs: { seg?: string; note?: string }[] = versions.map((x) => ({ seg: `${v.prefix}${x}` }));
  if (neutral) segs.push({});
  return segs;
}

function buildHttp(
  ctx: Ctx,
  cfg: AppConfig,
  consumers: Consumers,
  cls: ClassDeclaration,
  owner: ClassDeclaration,
  method: MethodDeclaration,
  verb: string,
  fullPath: string,
  routePath: string,
  extraMetadata: string[],
): EndpointDoc {
  const scope = newScope();
  const walker = new FlowWalker(ctx, consumers, scope);
  const warnings: string[] = [];
  const handlerName = `${cls.getName()}.${method.getName()}()`;
  const meta = routeMetadata(ctx, cls, method);

  // ---- request pipeline, in the order Nest runs it
  const items: Item[] = [];
  const add = (kind: Item['kind'], scopeName: Item['scope'], refs: Ref[], note?: string) => {
    for (const ref of refs) items.push({ kind, name: ref.name, scope: scopeName, note, loc: locOf(ctx, ref.node), ref });
  };
  add('middleware', 'global', cfg.middleware);
  for (const mm of cfg.moduleMiddleware) {
    const route = { controller: cls, method: verb, paths: [routePath, fullPath] };
    const verdicts = mm.targets.map((t) => targetMatches(t, route));
    const excluded = mm.excludes.some((t) => targetMatches(t, route) === 'yes');
    const best = (['yes', 'prefix', 'maybe'] as const).find((v) => verdicts.includes(v));
    if (!best || excluded) continue;
    if (best === 'maybe') {
      warnings.push(`Middleware ${mm.refs.map((r) => r.name).join(', ')} in ${mm.module} has a route target that could not be resolved statically; it is shown but may not apply.`);
    }
    add('middleware', 'module', mm.refs, best === 'prefix' ? 'matched as a path prefix' : best === 'maybe' ? 'target not resolved: may not apply' : undefined);
  }
  add('guard', 'global', cfg.guards);
  add('guard', 'controller', classRefs(ctx, cls, 'UseGuards'));
  add('guard', 'route', refsOf(ctx, method, 'UseGuards'));
  add('interceptor', 'global', cfg.interceptors);
  add('interceptor', 'controller', classRefs(ctx, cls, 'UseInterceptors'));
  add('interceptor', 'route', refsOf(ctx, method, 'UseInterceptors'));
  add('pipe', 'global', cfg.pipes);
  add('pipe', 'controller', classRefs(ctx, cls, 'UsePipes'));
  add('pipe', 'route', refsOf(ctx, method, 'UsePipes'));
  add('filter', 'global', cfg.filters);
  add('filter', 'controller', classRefs(ctx, cls, 'UseFilters'));
  add('filter', 'route', refsOf(ctx, method, 'UseFilters'));

  const params = describeParams(ctx, method);
  for (const p of params) for (const pipe of p.pipes) items.push({ kind: 'pipe', name: pipe, scope: 'param', note: `${p.in}${p.key ? ` '${p.key}'` : ''}`, loc: p.loc });

  const pipes = items.filter((i) => i.kind === 'pipe');
  const validationPipe = pipes.find((i) => (i.ref ? isValidationPipe(ctx, i.ref) : /ValidationPipe/.test(i.name)));
  const validationError = validationPipe?.ref ? pipeError(ctx, validationPipe.ref.node) : undefined;
  const validationStatus = validationError?.status ?? 400;
  // With `whitelist: true`, properties without decorators are stripped before the handler sees them.
  const whitelist = !!validationPipe && /whitelist:\s*true/.test(pipeOptionsText(ctx, validationPipe.ref?.node) ?? validationPipe.name);
  if (whitelist) {
    for (const p of params) {
      const undecorated = (f: { note?: string }) => !!f.note?.includes('no validators');
      const stripped = p.fields.filter(undecorated).map((f) => f.name);
      if (!stripped.length) continue;
      p.fields = p.fields.filter((f) => !undecorated(f));
      warnings.push(`${p.dto ?? p.type} declares ${stripped.join(', ')} without validators; ValidationPipe's whitelist strips them, so they are left out.`);
    }
  }

  // ---- response basics
  const httpCode = method.getDecorator('HttpCode');
  const redirect = method.getDecorator('Redirect');
  // `@Redirect()` handlers may return `{ url, statusCode }`, which overrides the decorator's code.
  const returnedCodes = redirect
    ? [...new Set(method.getDescendantsOfKind(SyntaxKind.ReturnStatement).map((r) => statusOf(objectProp(r.getExpression(), 'statusCode'))).filter((x) => x !== undefined))]
    : [];
  const successStatus =
    statusOf(httpCode?.getArguments()[0]) ?? (redirect ? (returnedCodes.length === 1 ? returnedCodes[0] : statusOf(redirect.getArguments()[1]) ?? 302) : verb === 'POST' ? 201 : 200);
  const metadata = [...metadataOf(cls), ...metadataOf(method), ...extraMetadata];
  for (const d of method.getDecorators()) {
    if (d.getName() === 'Redirect' || d.getName() === 'Header') metadata.push(`@${trunc(d.getText().replace(/^@/, ''), 50)}`);
  }
  const interceptors = items.filter((i) => i.kind === 'interceptor');
  const filters = items.filter((i) => i.kind === 'filter');
  const rawRes = params.filter((p) => p.rawResponse).map((p) => p.name);
  const direct = params.filter((p) => p.rawResponse && !p.passthrough).map((p) => p.name);
  if (direct.length) warnings.push(`Handler takes the raw response object (${direct.join(', ')}) without passthrough: interceptors and the default status code do not apply.`);

  const b = new GraphBuilder({
    kind: 'http',
    successStatus,
    postInterceptors: interceptors.map((i) => i.name.replace(/\(.*$/, '')),
    remap: filterRemap(ctx, filters),
  });

  // ---- draw
  let cur: Pending[] = [{ from: b.node([`${verb} ${fullPath}`, ...metadata.slice(0, 4)].join('\n'), 'stadium', 'request', 'request', locOf(ctx, method)) }];

  // Responses each pipeline item produced, to tell which guard or middleware can refuse the request.
  const owned = new Map<Item, EndpointDoc['responses']>();
  for (const m of items.filter((i) => i.kind === 'middleware')) {
    if (!cur.length) break;
    const before = b.responses.length;
    const id = b.node(`Middleware: ${m.name}${m.note ? `\n(${m.note})` : ''}`, 'rect', 'middleware', 'middleware', m.loc);
    b.link(cur, id);
    cur = [{ from: id }];
    const use = m.ref?.cls ? findCallable(ctx, m.ref.cls, 'use') : m.ref?.fn ? { fn: m.ref.fn, owner: undefined } : undefined;
    if (use) {
      const res = use.fn.getParameters()[1]?.getName();
      const req = use.fn.getParameters()[0]?.getName();
      const flow = b.emit(walker.entry(use.fn, use.owner, 'middleware', { res: res ? [res] : [], meta, verb, route: fullPath, req }), cur, 'middleware', m.name, id);
      cur = [...flow.next, ...flow.ret];
    }
    owned.set(m, b.responses.slice(before));
  }

  for (const g of items.filter((i) => i.kind === 'guard')) {
    if (!cur.length) break;
    const before = b.responses.length;
    const id = b.node(`Guard: ${g.name}\n(${g.scope})`, 'rect', 'middleware', 'middleware', g.loc);
    b.link(cur, id);
    const steps = guardSteps(ctx, walker, g, meta, verb, consumers);
    if (steps?.length) {
      const flow = b.emit(steps, [{ from: id }], 'guard', g.name, id);
      if (flow.next.length) b.error(flow.next, { status: 403, exception: 'ForbiddenException', message: 'Forbidden resource', origin: g.name });
      cur = flow.ret;
    } else {
      const base = g.name.replace(/\(.*$/, '');
      // A subclass of a library guard rejects like its base (MyThrottler extends ThrottlerGuard: 429).
      const bases = [base, ...(g.ref?.cls ? lineage(ctx, g.ref.cls).map((c) => c.getExtends()?.getExpression().getText() ?? '') : [])];
      const status = bases.map((x) => KNOWN_GUARD_STATUS[x]).find((x) => x !== undefined);
      b.error([{ from: id, label: 'rejects', dashed: true }], {
        status,
        head: status ? undefined : '401 / 403',
        exception: `rejected by ${base}`,
        origin: g.name,
      });
      cur = [{ from: id, label: 'passes' }];
      if (!status) scope.warnings.add(`Guard ${g.name} could not be followed (no canActivate found in the project), so its logic is not drawn.`);
    }
    owned.set(g, b.responses.slice(before));
  }

  for (const i of interceptors) {
    if (!cur.length) break;
    const id = b.node(`Interceptor: ${i.name}\n(${i.scope}, before handler)`, 'rect', 'middleware', 'middleware', i.loc);
    b.link(cur, id);
    cur = [{ from: id }];
    const intercept = i.ref?.cls ? findCallable(ctx, i.ref.cls, 'intercept') : undefined;
    if (intercept) {
      const flow = b.emit(walker.entry(intercept.fn, intercept.owner, 'middleware', { meta }), cur, 'middleware', i.name, id);
      cur = [...flow.next, ...flow.ret];
    }
  }

  for (const p of pipes.filter((i) => i.scope !== 'param' && i !== validationPipe && !/ValidationPipe/.test(i.name))) {
    if (!cur.length) break;
    const id = b.node(`Pipe: ${p.name}\n(${p.scope})`, 'rect', 'validation', 'validation', p.loc);
    b.link(cur, id);
    cur = [{ from: id }];
  }

  for (const p of params) {
    if (!cur.length) break;
    const where = `${p.in}${p.key ? ` '${p.key}'` : ''}`;
    p.pipes.forEach((pipe, idx) => {
      if (/^DefaultValuePipe|ValidationPipe/.test(pipe) || !cur.length) return;
      const id = b.node(`${pipe}\non ${where}`, 'rect', 'validation', 'validation', p.loc);
      b.link(cur, id);
      const custom = pipeError(ctx, p.pipeNodes[idx]);
      b.error([{ from: id, label: 'invalid' }], {
        status: custom?.status ?? 400,
        exception: custom?.exception ?? 'BadRequestException',
        message: custom?.message ?? `${where} is not valid`,
        origin: pipe,
        loc: p.loc,
      });
      cur = [{ from: id, label: 'valid' }];
    });
    if (!p.dto || !p.hasRules) continue;
    const names = (list: string[]) => (list.length > 7 ? `${list.slice(0, 7).join(', ')} +${list.length - 7} more` : list.join(', '));
    const required = p.fields.filter((f) => f.required).map((f) => f.name);
    const optional = p.fields.filter((f) => !f.required).map((f) => f.name);
    const lines = [`Validate ${where}: ${p.dto}`];
    if (required.length) lines.push(`required: ${names(required)}`);
    if (optional.length) lines.push(`optional: ${names(optional)}`);
    const active = validationPipe || p.pipes.some((x) => /ValidationPipe/.test(x));
    if (!active) lines.push('(no ValidationPipe found: rules not enforced)');
    const id = b.node(lines.join('\n'), 'rect', 'validation', 'validation', p.loc);
    b.link(cur, id);
    if (active) {
      b.error([{ from: id, label: 'invalid' }], { status: validationStatus, exception: 'ValidationPipe', message: validationError?.message ?? `${p.dto} failed validation`, origin: 'ValidationPipe', loc: p.loc });
      cur = [{ from: id, label: 'valid' }];
    } else {
      cur = [{ from: id }];
      warnings.push(`${p.dto} has class-validator rules but no ValidationPipe was found (global, controller, route or parameter level), so they may not run.`);
    }
  }

  const steps = walker.entry(method, owner, 'controller', { res: rawRes, self: cls });
  if (cur.length) {
    const h = b.node(handlerName, 'sub', 'controller', 'controller', locOf(ctx, method));
    b.link(cur, h);
    b.finish(b.emit(steps, [{ from: h }], 'handler', handlerName, h));
  }
  if (filters.length) {
    b.node(`Errors are formatted by:\n${filters.map((f) => f.name.replace(/\(.*$/, '')).join(', ')}`, 'rect', 'response', 'note');
  }

  // ---- response details
  const declared = declaredResponses(method);
  const detected = [...new Set(b.responses.map((r) => r.status).filter((s): s is number => s !== undefined))];
  if (declared.length) {
    const missing = detected.filter((s) => !declared.includes(String(s)));
    if (missing.length) warnings.push(`Responses found in code but not declared with @ApiResponse: ${missing.sort().join(', ')}.`);
  }
  const ret = returnInfo(ctx, method);
  const auth = authOf(ctx, cfg, cls, method, items, owned);
  if (ret.entity) warnings.push(`Handler returns the ${ret.entity} entity directly; check that no sensitive column is serialized.`);

  const ep: EndpointDoc = {
    id: slug(`${verb} ${fullPath}`),
    kind: 'http',
    method: verb,
    path: fullPath,
    group: cls.getName() ?? 'Controller',
    handler: handlerName,
    loc: locOf(ctx, method),
    summary: summaryOf(method),
    metadata,
    pipeline: items.map(({ ref, ...rest }) => rest),
    auth,
    params: params.filter((p) => !p.rawResponse).map(({ rawResponse, passthrough, pipeNodes, hasRules, ...rest }) => rest),
    entities: [...scope.entityOps].map(([entity, ops]) => describeEntity(ctx, entity, ops)).sort((x, y) => x.name.localeCompare(y.name)),
    returnType: ret.type,
    responseFields: ret.fields,
    responses: sortResponses(b.responses),
    declaredResponses: declared,
    steps,
    graph: b.graph(),
    mermaid: { flow: '', flowFlat: '', mindmap: '' },
    warnings: [...warnings, ...scope.warnings],
  };
  return withDiagrams(ep);
}

/**
 * The authentication a client must present, from the guards and middleware that can actually reject
 * this route (a guard skipped through @Public() does not count), with Swagger's @ApiBearerAuth /
 * @ApiBasicAuth / @ApiCookieAuth as a fallback.
 */
function authOf(ctx: Ctx, cfg: AppConfig, cls: ClassDeclaration, method: MethodDeclaration, items: Item[], owned: Map<Item, EndpointDoc['responses']>): AuthDoc {
  // Guards that can refuse the request, and middleware that answers 401 (a CSRF check's 403 is not authentication).
  const refuses = (i: Item, codes: (number | undefined)[]) => (owned.get(i) ?? []).some((r) => r.kind === 'error' && codes.includes(r.status));
  const rejecting = items.filter((i) => (i.kind === 'guard' && refuses(i, [401, 403, undefined])) || (i.kind === 'middleware' && refuses(i, [401])));
  let scheme: AuthDoc['scheme'] | undefined;
  let source: string | undefined;
  for (const i of rejecting) {
    scheme = authSchemeOf(ctx, i.ref, i.name);
    if (scheme) {
      source = i.name;
      break;
    }
  }
  // Swagger's auth decorators only name the scheme of a guard that answers 401 (not e.g. a captcha check).
  const unauthorized = rejecting.filter((i) => refuses(i, [401]));
  if (!scheme && unauthorized.length) {
    const hints = [...lineage(ctx, cls).flatMap((c) => c.getDecorators()), ...method.getDecorators()].map((d) => d.getName());
    if (hints.includes('ApiBearerAuth')) scheme = 'bearer';
    else if (hints.includes('ApiBasicAuth')) scheme = 'basic';
    else if (hints.includes('ApiCookieAuth')) scheme = 'cookie';
    if (scheme) source = `${unauthorized[0].name} with @Api${scheme === 'bearer' ? 'Bearer' : scheme === 'basic' ? 'Basic' : 'Cookie'}Auth`;
  }
  if (!scheme) return { scheme: 'none' };
  if (scheme !== 'cookie') return { scheme, source };
  return { scheme, cookie: sessionCookie(ctx), source };
}

/** The express-session cookie name: its `name` option, else express-session's default connect.sid. */
function sessionCookie(ctx: Ctx): string | undefined {
  for (const sf of ctx.files) {
    const imp = sf.getImportDeclarations().find((i) => i.getModuleSpecifierValue() === 'express-session');
    const local = imp?.getDefaultImport()?.getText() ?? imp?.getNamespaceImport()?.getText();
    if (!local) continue;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== local) continue;
      return literalText(objectProp(call.getArguments()[0], 'name')) ?? 'connect.sid';
    }
  }
  return undefined;
}

function withDiagrams(ep: EndpointDoc): EndpointDoc {
  ep.mermaid = { flow: flowchart(ep.graph, true), flowFlat: flowchart(ep.graph, false), mindmap: endpointMindmap(ep) };
  return ep;
}

function sortResponses(list: EndpointDoc['responses']): EndpointDoc['responses'] {
  return [...list].sort((a, b) => (a.kind === b.kind ? (a.status ?? 999) - (b.status ?? 999) : a.kind === 'success' ? -1 : 1));
}

function summaryOf(method: MethodDeclaration): string | undefined {
  const doc = method.getJsDocs()[0]?.getDescription().trim();
  if (doc) return oneLine(doc);
  const op = method.getDecorator('ApiOperation');
  return literalText(objectProp(op?.getArguments()[0], 'summary'));
}

function declaredResponses(method: MethodDeclaration): string[] {
  const out: string[] = [];
  for (const d of method.getDecorators()) {
    const name = d.getName();
    if (SWAGGER_STATUS[name]) out.push(String(SWAGGER_STATUS[name]));
    else if (name === 'ApiResponse') {
      const status = statusOf(objectProp(d.getArguments()[0], 'status'));
      if (status) out.push(String(status));
    }
  }
  return [...new Set(out)].sort();
}

function returnInfo(ctx: Ctx, method: MethodDeclaration): { type?: string; entity?: string; fields?: { name: string; type: string; note?: string }[] } {
  let typeNode: Node | undefined = method.getReturnTypeNode();
  let type: string | undefined = typeNode ? oneLine(typeNode.getText()) : undefined;
  if (!type) {
    try {
      const inferred = oneLine(method.getReturnType().getText(method));
      if (inferred && !/\bany\b/.test(inferred)) type = trunc(inferred, 90);
    } catch {
      /* unresolved */
    }
  }
  // Promise<User[]> -> User
  for (let i = 0; i < 3 && typeNode; i++) {
    if (Node.isArrayTypeNode(typeNode)) typeNode = typeNode.getElementTypeNode();
    else if (Node.isTypeReference(typeNode) && /^(Promise|Observable|Array)$/.test(typeNode.getTypeName().getText())) typeNode = typeNode.getTypeArguments()[0];
    else break;
  }
  const decl = typeNode && Node.isTypeNode(typeNode) ? resolveTypeNode(ctx, typeNode) : undefined;
  if (!decl || !Node.isClassDeclaration(decl)) return { type };
  const fields = decl
    .getInstanceProperties()
    .filter(Node.isPropertyDeclaration)
    .map((p) => {
      const decs = p.getDecorators();
      const notes: string[] = [];
      if (decs.some((d) => d.getName() === 'Exclude')) notes.push('excluded by class-transformer');
      if (decs.some((d) => d.getName() === 'Expose')) notes.push('exposed');
      const column = decs.find((d) => d.getName() === 'Column');
      if (objectProp(column?.getArguments().find((a) => Node.isObjectLiteralExpression(a)), 'select')?.getText() === 'false') {
        notes.push('not selected by default');
      }
      return { name: p.getName(), type: trunc(p.getTypeNode()?.getText() ?? 'unknown', 40), note: notes.join(', ') || undefined };
    });
  return { type, entity: isEntity(decl) ? decl.getName() : undefined, fields };
}

// ---------------------------------------------------------------------------------------------
// Guards

function guardSteps(ctx: Ctx, walker: FlowWalker, g: Item, meta: RouteMeta, verb: string, consumers: Consumers): Step[] | undefined {
  const cls = g.ref?.cls;
  const inline = /^AuthGuard\(\s*(.*)\)$/.exec(g.name);
  if (!cls) return inline ? [...passportSteps(ctx, walker, strategyNames(inline[1])), { kind: 'return', layer: 'middleware', verdict: true }] : undefined;

  let passport: Step[] | undefined;
  // `handleRequest()` decides what a rejected strategy turns into (401 by default).
  const handle = findCallable(ctx, cls, 'handleRequest');
  let reject: Step | undefined;
  if (handle) {
    // A throwaway walker: handleRequest is only read for what it throws, not drawn.
    const steps = new FlowWalker(ctx, consumers, newScope()).entry(handle.fn, handle.owner, 'middleware', { self: cls });
    const visit = (list: Step[]): Step | undefined => {
      for (const s of list) {
        if (s.kind === 'throw') return s;
        const nested = s.kind === 'if' ? visit([...s.then, ...(s.else ?? [])]) : 'body' in s && s.body ? visit(s.body) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    reject = visit(steps);
  }
  for (const c of lineage(ctx, cls)) {
    const ext = c.getExtends()?.getExpression();
    if (ext && Node.isCallExpression(ext) && ext.getExpression().getText() === 'AuthGuard') {
      passport = passportSteps(ctx, walker, literalList(ext.getArguments()[0]), reject);
    }
  }
  const can = findCallable(ctx, cls, 'canActivate');
  if (can && can.fn !== handle?.fn) return walker.entry(can.fn, can.owner, 'middleware', { passport, self: cls, meta, verb });
  if (passport) return [...passport, { kind: 'return', layer: 'middleware', verdict: true }];
  return undefined;
}

function strategyNames(text: string): string[] {
  return [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

/** What Passport's AuthGuard does: run the named strategy, 401 if it rejects. */
function passportSteps(ctx: Ctx, walker: FlowWalker, names: string[], reject?: Step): Step[] {
  const label = names.length ? names.join(' / ') : 'default';
  const validate: Step[] = [];
  for (const cls of ctx.classes) {
    const ext = cls.getExtends()?.getExpression();
    if (!ext || !Node.isCallExpression(ext) || ext.getExpression().getText() !== 'PassportStrategy') continue;
    const args = ext.getArguments();
    let strategy = literalText(args[1]);
    if (!strategy && args[0]) {
      const imported = cls
        .getSourceFile()
        .getImportDeclarations()
        .find((i) => i.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === args[0].getText()));
      strategy = imported?.getModuleSpecifierValue().replace(/^passport-/, '');
    }
    if (names.length && strategy && !names.includes(strategy)) continue;
    const fn = findCallable(ctx, cls, 'validate');
    if (fn) validate.push({ kind: 'call', layer: 'middleware', label: `${cls.getName()}.validate()`, body: walker.entry(fn.fn, fn.owner, 'middleware'), loc: locOf(ctx, fn.fn) });
  }
  return [
    {
      kind: 'if',
      layer: 'middleware',
      cond: `Passport '${label}' strategy accepts the credentials`,
      then: validate,
      else: [reject ?? { kind: 'throw', layer: 'middleware', exception: 'UnauthorizedException', status: 401, message: 'Unauthorized' }],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Background entry points: queue processors, event listeners, schedules, message handlers

function backgroundEntries(ctx: Ctx, consumers: Consumers, cls: ClassDeclaration): EndpointDoc[] {
  const out: EndpointDoc[] = [];
  const proc = cls.getDecorator('Processor');
  const procArg = proc?.getArguments()[0];
  const queue = proc ? literalText(procArg) ?? literalText(objectProp(procArg, 'name')) ?? '?' : undefined;

  for (const method of cls.getInstanceMethods()) {
    const entries: { method: string; path: string }[] = [];
    if (queue !== undefined && method.getName() === 'process' && !method.getDecorator('Process')) {
      entries.push({ method: 'JOB', path: `queue '${queue}'` });
    }
    for (const d of method.getDecorators()) {
      const arg = d.getArguments()[0];
      const text = literalText(arg) ?? literalText(objectProp(arg, 'name')) ?? (arg ? trunc(arg.getText(), 40) : '');
      switch (d.getName()) {
        case 'Process':
          entries.push({ method: 'JOB', path: `queue '${queue ?? '?'}'${text ? ` job '${text}'` : ''}` });
          break;
        case 'OnEvent':
          for (const e of literalList(arg).length ? literalList(arg) : [text]) entries.push({ method: 'EVENT', path: e });
          break;
        case 'Cron':
        case 'Interval':
        case 'Timeout':
          entries.push({ method: 'CRON', path: `${d.getName().toLowerCase()} ${text}`.trim() });
          break;
        case 'MessagePattern':
        case 'EventPattern':
          entries.push({ method: 'MESSAGE', path: text });
          break;
      }
    }
    for (const e of entries) out.push(buildBackground(ctx, consumers, cls, method, e.method, e.path));
  }
  return out;
}

function buildBackground(ctx: Ctx, consumers: Consumers, cls: ClassDeclaration, method: MethodDeclaration, kind: string, path: string): EndpointDoc {
  const scope = newScope();
  const walker = new FlowWalker(ctx, consumers, scope);
  const handlerName = `${cls.getName()}.${method.getName()}()`;
  const b = new GraphBuilder({ kind: 'job', successStatus: 0, postInterceptors: [] });
  const start = b.node(`${kind} ${path}`, 'stadium', 'request', 'request', locOf(ctx, method));
  const h = b.node(handlerName, 'sub', 'service', 'service', locOf(ctx, method));
  b.edge(start, h);
  const steps = walker.entry(method, cls, 'service');
  b.finish(b.emit(steps, [{ from: h }], 'job', handlerName, h));
  return withDiagrams({
    id: slug(`${kind} ${path} ${method.getName()}`),
    kind: 'job',
    method: kind,
    path,
    group: cls.getName() ?? 'Background',
    handler: handlerName,
    loc: locOf(ctx, method),
    summary: summaryOf(method),
    metadata: metadataOf(method),
    pipeline: [],
    params: [],
    entities: [...scope.entityOps].map(([entity, ops]) => describeEntity(ctx, entity, ops)).sort((x, y) => x.name.localeCompare(y.name)),
    responses: sortResponses(b.responses),
    declaredResponses: [],
    steps,
    graph: b.graph(),
    mermaid: { flow: '', flowFlat: '', mindmap: '' },
    warnings: [...scope.warnings],
  });
}
