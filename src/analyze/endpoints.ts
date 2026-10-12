import { ClassDeclaration, Decorator, MethodDeclaration, Node } from 'ts-morph';
import { ROUTE_DECORATORS } from '../http';
import { AppDoc, EndpointDoc, PipelineItem, Step } from '../model';
import {
  Ctx,
  findCallable,
  lineage,
  literalList,
  literalText,
  locOf,
  objectProp,
  oneLine,
  resolveTypeNode,
  statusOf,
  trunc,
  unwrap,
} from '../project';
import { GraphBuilder, Pending } from '../render/graph';
import { endpointMindmap, flowchart, overviewMindmap } from '../render/mermaid';
import { AppConfig, Ref, parseRef, readAppConfig, targetMatches } from './app-config';
import { describeEntity, isEntity } from './entities';
import { Consumers, FlowWalker, Scope } from './flow';
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
const VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function analyze(ctx: Ctx, name: string): AppDoc {
  const cfg = readAppConfig(ctx);
  const consumers = indexConsumers(ctx);
  const endpoints: EndpointDoc[] = [];

  for (const cls of ctx.classes) {
    if (cls.getDecorator('Controller')) endpoints.push(...httpEndpoints(ctx, cfg, consumers, cls));
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || verbRank(a.method) - verbRank(b.method));
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

function refsOf(ctx: Ctx, node: { getDecorators(): Decorator[] }, decorator: string): Ref[] {
  return node
    .getDecorators()
    .filter((d) => d.getName() === decorator)
    .flatMap((d) => d.getArguments().map((a) => parseRef(ctx, a)));
}

function isValidationPipe(ctx: Ctx, ref: Ref): boolean {
  if (/^ValidationPipe\b/.test(ref.name)) return true;
  if (/ValidationPipe/.test(ref.name) && /^factory:/.test(ref.name)) return true;
  return !!ref.cls && lineage(ctx, ref.cls).some((c) => /ValidationPipe$/.test(c.getExtends()?.getExpression().getText() ?? ''));
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
  const ctrlVersions = ctrlObject ? literalList(objectProp(ctrlArg, 'version')) : [];

  const seen = new Set<string>();
  for (const owner of lineage(ctx, cls)) {
    for (const method of owner.getInstanceMethods()) {
      if (seen.has(method.getName())) continue;
      const routes = method.getDecorators().filter((d) => ROUTE_DECORATORS[d.getName()]);
      if (!routes.length) continue;
      seen.add(method.getName());
      for (const route of routes) {
        const verb = ROUTE_DECORATORS[route.getName()];
        const arg = route.getArguments()[0];
        let methodPaths = literalList(arg);
        if (!methodPaths.length) methodPaths = [arg ? `{${trunc(arg.getText(), 30)}}` : ''];
        const versionDec = method.getDecorator('Version');
        const methodVersions = versionDec ? literalList(versionDec.getArguments()[0]) : [];
        const versions = methodVersions.length ? methodVersions : ctrlVersions.length ? ctrlVersions : cfg.versioning?.defaultVersion ?? [];
        const uriVersioning = !cfg.versioning || cfg.versioning.type === 'URI';
        const versionSegs: (string | undefined)[] = versions.length && uriVersioning ? versions.map((v) => `${cfg.versioning?.prefix ?? 'v'}${v}`) : [undefined];
        for (const versionSeg of versionSegs) {
          for (const cp of ctrlPaths.length ? ctrlPaths : ['']) {
            for (const mp of methodPaths) {
              const extra: string[] = [];
              if (versions.length && !uriVersioning) extra.push(`version ${versions.join(', ')} selected by ${cfg.versioning!.type}`);
              out.push(
                buildHttp(ctx, cfg, consumers, cls, owner, method, verb, joinPath(cfg.globalPrefix, versionSeg, cp, mp), joinPath(cp, mp), extra),
              );
            }
          }
        }
      }
    }
  }
  return out;
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
  const scope: Scope = { warnings: new Set(), expanded: new Map(), entityOps: new Map() };
  const walker = new FlowWalker(ctx, consumers, scope);
  const warnings: string[] = [];
  const handlerName = `${cls.getName()}.${method.getName()}()`;

  // ---- request pipeline, in the order Nest runs it
  const items: Item[] = [];
  const add = (kind: Item['kind'], scopeName: Item['scope'], refs: Ref[], note?: string) => {
    for (const ref of refs) items.push({ kind, name: ref.name, scope: scopeName, note, loc: locOf(ctx, ref.node), ref });
  };
  add('middleware', 'global', cfg.middleware);
  for (const mm of cfg.moduleMiddleware) {
    const route = { controller: cls, method: verb, paths: [routePath, fullPath] };
    const verdicts = mm.targets.map((t) => targetMatches(t, route));
    const excluded = mm.excludes.some((t) => ['yes', 'prefix'].includes(targetMatches(t, route)));
    const best = (['yes', 'prefix', 'maybe'] as const).find((v) => verdicts.includes(v));
    if (!best || excluded) continue;
    if (best === 'maybe') {
      warnings.push(`Middleware ${mm.refs.map((r) => r.name).join(', ')} in ${mm.module} has a route target that could not be resolved statically; it is shown but may not apply.`);
    }
    add('middleware', 'module', mm.refs, best === 'prefix' ? 'matched as a path prefix' : best === 'maybe' ? 'target not resolved: may not apply' : undefined);
  }
  add('guard', 'global', cfg.guards);
  add('guard', 'controller', refsOf(ctx, cls, 'UseGuards'));
  add('guard', 'route', refsOf(ctx, method, 'UseGuards'));
  add('interceptor', 'global', cfg.interceptors);
  add('interceptor', 'controller', refsOf(ctx, cls, 'UseInterceptors'));
  add('interceptor', 'route', refsOf(ctx, method, 'UseInterceptors'));
  add('pipe', 'global', cfg.pipes);
  add('pipe', 'controller', refsOf(ctx, cls, 'UsePipes'));
  add('pipe', 'route', refsOf(ctx, method, 'UsePipes'));
  add('filter', 'global', cfg.filters);
  add('filter', 'controller', refsOf(ctx, cls, 'UseFilters'));
  add('filter', 'route', refsOf(ctx, method, 'UseFilters'));

  const params = describeParams(ctx, method);
  for (const p of params) for (const pipe of p.pipes) items.push({ kind: 'pipe', name: pipe, scope: 'param', note: `${p.in}${p.key ? ` '${p.key}'` : ''}`, loc: p.loc });

  const pipes = items.filter((i) => i.kind === 'pipe');
  const validationPipe = pipes.find((i) => (i.ref ? isValidationPipe(ctx, i.ref) : /ValidationPipe/.test(i.name)));
  const validationStatus = Number(/errorHttpStatusCode:\s*(\d{3})/.exec(validationPipe?.name ?? '')?.[1] ?? 400);

  // ---- response basics
  const httpCode = method.getDecorator('HttpCode');
  const successStatus = statusOf(httpCode?.getArguments()[0]) ?? (verb === 'POST' ? 201 : 200);
  const metadata = [...metadataOf(cls), ...metadataOf(method), ...extraMetadata];
  for (const d of method.getDecorators()) {
    if (d.getName() === 'Redirect' || d.getName() === 'Header') metadata.push(`@${trunc(d.getText().replace(/^@/, ''), 50)}`);
  }
  const interceptors = items.filter((i) => i.kind === 'interceptor');
  const filters = items.filter((i) => i.kind === 'filter');
  const rawRes = params.filter((p) => p.rawResponse).map((p) => p.name);
  if (rawRes.length) warnings.push(`Handler takes the raw response object (${rawRes.join(', ')}): unless passthrough is set, interceptors and the default status code do not apply.`);

  const b = new GraphBuilder({
    kind: 'http',
    successStatus,
    postInterceptors: interceptors.map((i) => i.name.replace(/\(.*$/, '')),
  });

  // ---- draw
  let cur: Pending[] = [{ from: b.node([`${verb} ${fullPath}`, ...metadata.slice(0, 4)].join('\n'), 'stadium', 'request', 'request', locOf(ctx, method)) }];

  for (const m of items.filter((i) => i.kind === 'middleware')) {
    if (!cur.length) break;
    const id = b.node(`Middleware: ${m.name}${m.note ? `\n(${m.note})` : ''}`, 'rect', 'middleware', 'middleware', m.loc);
    b.link(cur, id);
    cur = [{ from: id }];
    const use = m.ref?.cls ? findCallable(ctx, m.ref.cls, 'use') : undefined;
    if (use) {
      const res = use.fn.getParameters()[1]?.getName();
      const flow = b.emit(walker.entry(use.fn, use.owner, 'middleware', { res: res ? [res] : [] }), cur, 'middleware', m.name, id);
      cur = [...flow.next, ...flow.ret];
    }
  }

  for (const g of items.filter((i) => i.kind === 'guard')) {
    if (!cur.length) break;
    const id = b.node(`Guard: ${g.name}\n(${g.scope})`, 'rect', 'middleware', 'middleware', g.loc);
    b.link(cur, id);
    const steps = guardSteps(ctx, walker, g);
    if (steps?.length) {
      const flow = b.emit(steps, [{ from: id }], 'guard', g.name, id);
      if (flow.next.length) b.error(flow.next, { status: 403, exception: 'ForbiddenException', message: 'Forbidden resource', origin: g.name });
      cur = flow.ret;
    } else {
      const base = g.name.replace(/\(.*$/, '');
      const status = KNOWN_GUARD_STATUS[base];
      b.error([{ from: id, label: 'rejects', dashed: true }], {
        status,
        head: status ? undefined : '401 / 403',
        exception: `rejected by ${base}`,
        origin: g.name,
      });
      cur = [{ from: id, label: 'passes' }];
      if (!status) scope.warnings.add(`Guard ${g.name} could not be followed (no canActivate found in the project), so its logic is not drawn.`);
    }
  }

  for (const i of interceptors) {
    if (!cur.length) break;
    const id = b.node(`Interceptor: ${i.name}\n(${i.scope}, before handler)`, 'rect', 'middleware', 'middleware', i.loc);
    b.link(cur, id);
    cur = [{ from: id }];
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
    for (const pipe of p.pipes) {
      if (/^DefaultValuePipe|ValidationPipe/.test(pipe)) continue;
      const id = b.node(`${pipe}\non ${where}`, 'rect', 'validation', 'validation', p.loc);
      b.link(cur, id);
      b.error([{ from: id, label: 'invalid' }], { status: 400, exception: 'BadRequestException', message: `${where} is not valid`, origin: pipe, loc: p.loc });
      cur = [{ from: id, label: 'valid' }];
    }
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
      b.error([{ from: id, label: 'invalid' }], { status: validationStatus, exception: 'ValidationPipe', message: `${p.dto} failed validation`, origin: 'ValidationPipe', loc: p.loc });
      cur = [{ from: id, label: 'valid' }];
    } else {
      cur = [{ from: id }];
      warnings.push(`${p.dto} has class-validator rules but no ValidationPipe was found (global, controller, route or parameter level), so they may not run.`);
    }
  }

  const steps = walker.entry(method, owner === cls ? cls : owner, 'controller', { res: rawRes });
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
    params: params.filter((p) => !p.rawResponse).map(({ rawResponse, hasRules, ...rest }) => rest),
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

function guardSteps(ctx: Ctx, walker: FlowWalker, g: Item): Step[] | undefined {
  const cls = g.ref?.cls;
  const inline = /^AuthGuard\(\s*(.*)\)$/.exec(g.name);
  if (!cls) return inline ? [...passportSteps(ctx, walker, strategyNames(inline[1])), { kind: 'return', layer: 'middleware', verdict: true }] : undefined;

  let passport: Step[] | undefined;
  for (const c of lineage(ctx, cls)) {
    const ext = c.getExtends()?.getExpression();
    if (ext && Node.isCallExpression(ext) && ext.getExpression().getText() === 'AuthGuard') {
      passport = passportSteps(ctx, walker, literalList(ext.getArguments()[0]));
    }
  }
  const can = findCallable(ctx, cls, 'canActivate');
  if (can) return walker.entry(can.fn, can.owner, 'middleware', { passport });
  if (passport) return [...passport, { kind: 'return', layer: 'middleware', verdict: true }];
  return undefined;
}

function strategyNames(text: string): string[] {
  return [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

/** What Passport's AuthGuard does: run the named strategy, 401 if it rejects. */
function passportSteps(ctx: Ctx, walker: FlowWalker, names: string[]): Step[] {
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
      else: [{ kind: 'throw', layer: 'middleware', exception: 'UnauthorizedException', status: 401, message: 'Unauthorized' }],
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
  const scope: Scope = { warnings: new Set(), expanded: new Map(), entityOps: new Map() };
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
