import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyze } from '../src/analyze/endpoints';
import { AppDoc, EndpointDoc, FieldRule, Step } from '../src/model';
import { loadProject } from '../src/project';
import { exportRequests } from '../src/render/collections';
import { assembleOpenApi, openApiParts } from '../src/render/openapi';

// Each test here pins down a case where the generated documentation used to disagree with what
// Nest actually does. The fixture is test/fixtures/accuracy.

const ROOT = path.join(__dirname, '..', '..');
const app: AppDoc = analyze(loadProject(path.join(ROOT, 'test/fixtures/accuracy'), { depth: 6, verbose: false }), 'accuracy');

function ep(method: string, p: string): EndpointDoc {
  const found = app.endpoints.find((e) => e.method === method && e.path === p);
  assert.ok(found, `missing ${method} ${p}; have ${app.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}
const statuses = (e: EndpointDoc) => [...new Set(e.responses.map((r) => r.status))].sort();
const response = (e: EndpointDoc, status: number) => e.responses.filter((r) => r.status === status);
const guards = (e: EndpointDoc) => e.pipeline.filter((p) => p.kind === 'guard').map((p) => p.name);
const middleware = (e: EndpointDoc) => e.pipeline.filter((p) => p.kind === 'middleware').map((p) => p.name);
const field = (e: EndpointDoc, name: string): FieldRule | undefined => e.params.flatMap((p) => p.fields).find((f) => f.name === name);
function walk(steps: Step[], visit: (s: Step) => void) {
  for (const s of steps) {
    visit(s);
    if ('body' in s && s.body) walk(s.body, visit);
    if (s.kind === 'if') walk([...s.then, ...(s.else ?? [])], visit);
    if (s.kind === 'switch') for (const c of s.cases) walk(c.body, visit);
    if (s.kind === 'try') walk([...(s.catchBody ?? []), ...(s.finallyBody ?? [])], visit);
  }
}

test('routes: prefix fallback, prefix exclude, default version, VERSION_NEUTRAL, class-level @Version', () => {
  const list = app.endpoints.filter((e) => e.kind === 'http').map((e) => `${e.method} ${e.path}`);
  for (const route of ['GET /health', 'GET /api/v2/things', 'GET /api/v1/items', 'POST /api/v1/items', 'GET /api/v1/dogs', 'POST /api/v1/callbacks']) {
    assert.ok(list.includes(route), `${route} in ${list.join(', ')}`);
  }
  assert.ok(app.warnings.some((w) => /fallback 'api'/.test(w)), 'says the prefix came from a fallback');
});

test('routes: an override without a route decorator removes the inherited route', () => {
  assert.ok(!app.endpoints.some((e) => e.path.endsWith('/callbacks/legacy')));
});

test('bootstrap: only the file that listens is the HTTP app; helpers called with the app are read', () => {
  assert.ok(!app.warnings.some((w) => /files that call NestFactory\.create/.test(w)));
  assert.equal(app.versioning, 'URI (prefix "v")');
  assert.equal(app.validationPipe?.split('(')[0], 'I18nValidationPipe');
  const create = ep('POST', '/api/v1/items');
  assert.equal(middleware(create)[0].split('(')[0], 'session');
  assert.ok(response(create, 403).some((r) => /Invalid CSRF token/.test(r.label + r.when)), 'inline middleware body is drawn');
  assert.ok(response(create, 422).some((r) => r.label === 'ValidationPipe'), 'errorHttpStatusCode given as HttpStatus.X');
  assert.ok(!create.warnings.some((w) => /no ValidationPipe/.test(w)));
});

test('guards: inside applyDecorators, inherited from a base controller, @Public honoured, ThrottlerGuard subclass', () => {
  const create = ep('POST', '/api/v1/items');
  assert.deepEqual(guards(create), ['SessionGuard']);
  assert.ok(response(create, 401).some((r) => r.when === 'Not logged in'));
  const pub = ep('GET', '/api/v1/items/public');
  assert.deepEqual(statuses(pub).filter((s) => s === 401), [], '@Public() skips the session check');
  assert.deepEqual(guards(ep('POST', '/api/v1/callbacks')), ['CallbackAuthGuard']);
  assert.deepEqual(statuses(ep('GET', '/api/v1/limited')).filter((s) => s && s >= 400), [429]);
});

test('module middleware: chained apply/forRoutes and exact exclude', () => {
  assert.deepEqual(middleware(ep('GET', '/api/v1/dogs')).slice(-2), ['AMiddleware', 'CMiddleware']);
  const items = middleware(ep('GET', '/api/v1/items'));
  assert.ok(items.includes('BMiddleware') && !items.includes('AMiddleware') && !items.includes('CMiddleware'), items.join());
  assert.ok(middleware(ep('GET', '/api/v1/items/:id')).includes('CMiddleware'), "exclude('items') does not cover /items/:id");
});

test('exceptions: status and message through a custom hierarchy; built-ins not shadowed by same-named project classes', () => {
  const cb = ep('POST', '/api/v1/callbacks');
  assert.deepEqual(response(cb, 409).map((r) => r.when), ['Already processed']);
  assert.ok(response(ep('GET', '/api/v1/items/callback/:id'), 404).length, "NotFoundException from '@nestjs/common' is 404");
  assert.ok(!statuses(ep('GET', '/api/v1/items/callback/:id')).includes(410));
});

test('flow: template method calls the subclass override', () => {
  assert.deepEqual(response(ep('POST', '/api/v1/items'), 409).map((r) => r.when), ['Item already exists']);
});

test('flow: a rethrow in catch keeps the statuses thrown inside the try', () => {
  const e = ep('GET', '/api/v1/items/rethrow/:id');
  for (const s of [404, 403, 500]) assert.ok(statuses(e).includes(s), `${s} in ${statuses(e)}`);
});

test('flow: try whose body has no drawn call still reaches its catch', () => {
  assert.deepEqual(response(ep('GET', '/api/v1/items/parse'), 400).map((r) => r.when), ['Body is not JSON']);
});

test('flow: callbacks and conditional expressions are conditional', () => {
  for (const p of ['/api/v1/items/callback/:id', '/api/v1/items/cond', '/api/v1/items/upstream']) {
    assert.ok(statuses(ep('GET', p)).includes(200), `${p} keeps its success response: ${statuses(ep('GET', p))}`);
  }
  assert.ok(response(ep('GET', '/api/v1/items/callback/:id'), 404).length);
  assert.ok(response(ep('GET', '/api/v1/items/cond'), 403).length);
  assert.ok(response(ep('GET', '/api/v1/items/upstream'), 502).length);
  assert.ok(ep('GET', '/api/v1/items/upstream').graph.nodes.some((n) => /^HTTP GET/.test(n.label)));
});

test('flow: switch fallthrough, continue in a loop', () => {
  const sw = ep('GET', '/api/v1/items/switch/:k').steps.find((s) => s.kind === 'switch');
  assert.ok(sw && sw.kind === 'switch');
  const a = sw.cases.find((c) => c.label === "'a'")!;
  let throws = false;
  walk(a.body, (s) => (throws ||= s.kind === 'throw'));
  assert.ok(throws, "case 'a' falls through into the throw");

  const loop = ep('GET', '/api/v1/items/loop').steps.find((s) => s.kind === 'loop');
  assert.ok(loop && loop.kind === 'loop' && loop.body[0].kind === 'if', 'the throw after `if (!id) continue` is conditional');
});

test('flow: throw helper(), repeated call keeps its errors, abstract class with one implementation', () => {
  assert.deepEqual(response(ep('GET', '/api/v1/items/helper'), 422).map((r) => r.label), ['UnprocessableEntityException']);
  assert.ok(statuses(ep('GET', '/api/v1/items/twice/:id')).includes(404));
  assert.ok(statuses(ep('GET', '/api/v1/items/rethrow/:id')).includes(500), 'SqlItemRepository.findById is followed');
});

test('success status: @Redirect, res.status() with passthrough', () => {
  assert.deepEqual(ep('GET', '/api/v1/items/redir').responses.filter((r) => r.kind === 'success').map((r) => r.status), [301]);
  assert.ok(statuses(ep('GET', '/api/v1/items/passthrough')).includes(428));
  assert.ok(!ep('GET', '/api/v1/items/passthrough').warnings.some((w) => /unless passthrough/.test(w)));
});

test('param pipe exceptionFactory decides the status', () => {
  const e = ep('GET', '/api/v1/items/:id');
  assert.ok(response(e, 404).some((r) => r.when === 'Item id not found'));
  assert.ok(!response(e, 400).some((r) => r.origin.startsWith('ParseIntPipe')));
});

test('validation: IntersectionType, @Expose name, IsIn constants and options, ValidateIf, IsEmpty, Allow, inherited IsOptional', () => {
  const create = ep('POST', '/api/v1/items');
  for (const n of ['name', 'email', 'external_id']) assert.ok(field(create, n), `${n} present`);
  assert.ok(!field(create, 'externalId'));
  assert.deepEqual(field(create, 'kind')!.values, ['a', 'b']);
  assert.deepEqual(field(create, 'tag')!.values, ['x', 'y']);
  for (const n of ['startDate', 'type', 'hint']) assert.equal(field(create, n)!.required, false, `${n} optional`);
  const limit = field(ep('GET', '/api/v1/items'), 'limit')!;
  assert.equal(limit.required, false);
  assert.deepEqual(limit.rules, ['Max(100)']);
});

test('OpenAPI: option objects ignored, regex flags, nullable, security, optional headers', () => {
  const parts = openApiParts(app);
  const doc = assembleOpenApi(parts, parts.operations, 'http://h') as any;
  const dto = doc.components.schemas.CreateItemDto;
  assert.deepEqual(dto.properties.tag.enum, ['x', 'y']);
  assert.equal(dto.properties.count.minimum, 5);
  assert.equal(dto.properties.external_id.format, 'uuid');
  assert.equal(dto.properties.code.pattern, undefined, 'a case-insensitive regex cannot be a JSON Schema pattern');
  assert.equal(dto.properties.title.nullable, undefined, '@IsNotEmpty rejects null');
  assert.ok(!dto.required.includes('type') && !dto.required.includes('hint'));
  assert.deepEqual(doc.paths['/api/v1/callbacks'].post.security, [{ basicAuth: [] }]);
  assert.deepEqual(doc.paths['/api/v1/items'].post.security, [{ cookieAuth: [] }]);
  assert.equal(doc.components.securitySchemes.cookieAuth.name, 'connect.sid');
  assert.equal(doc.paths['/api/v1/items/public'].get.security, undefined, '@Public endpoint needs no session');
  const header = doc.paths['/api/v1/callbacks'].post.parameters.find((p: any) => p.in === 'header');
  assert.equal(header.required, false);
});

test('examples satisfy the validators', () => {
  const body = exportRequests(app).find((r) => r.method === 'POST' && r.path === '/api/v1/items')!.body as any;
  const v = body.value;
  assert.match(v.external_id, /^[0-9a-f-]{36}$/);
  assert.ok(v.name.length > 0 && v.title.length > 0, 'IsNotEmpty strings are not empty');
  assert.equal(v.count, 5);
  assert.equal(v.tag, 'x');
  assert.equal(v.type, undefined, '@IsEmpty field is left out');
});

test('exception filters that set a status remap the documented response', () => {
  const e = ep('POST', '/api/v1/quota');
  assert.deepEqual(statuses(e).filter((s) => s && s >= 400 && s !== 403 && s !== 401), [422]);
  assert.ok(response(e, 422).some((r) => r.label === 'QuotaError' && /DomainErrorFilter/.test(r.origin)));
});

test('a Passport guard that overrides handleRequest rejects the way handleRequest does', () => {
  const e = ep('GET', '/api/v1/strict');
  assert.ok(response(e, 403).some((r) => r.when === 'Token rejected'));
  assert.ok(!response(e, 401).some((r) => r.when === 'Unauthorized'));
  assert.equal(e.auth?.scheme, 'bearer');
});

test('OpenAPI: constant bounds, and routes OpenAPI cannot describe are listed', () => {
  const parts = openApiParts(app);
  const doc = assembleOpenApi(parts, parts.operations, 'http://h') as any;
  assert.equal(doc.components.schemas.CreateItemDto.properties.count.maximum, 50);
  assert.match(doc.info.description, /ALL \/api\/v1\/quota\/any/);
});

test('middleware checks on req.path are decided per route', () => {
  assert.ok(!response(ep('POST', '/api/v1/callbacks'), 403).some((r) => /CSRF/.test(r.label + r.when)), 'callbacks are excluded from the CSRF check');
  assert.ok(response(ep('POST', '/api/v1/items'), 403).some((r) => /CSRF/.test(r.label + r.when)));
});

// ---- second review round

test('exceptions: the super() branch is chosen by the argument; spread constructor arguments', () => {
  assert.deepEqual(response(ep('POST', '/api/v1/review/keyed'), 409).map((r) => r.when).sort(), ['Plain message', 'errors.translated']);
  assert.deepEqual(response(ep('POST', '/api/v1/review/spread'), 422).map((r) => r.when), ['Too much']);
});

test('nested catch-and-rethrow lists each error once', () => {
  const rows = ep('GET', '/api/v1/review/nested').responses.filter((r) => r.kind === 'error');
  const keys = rows.map((r) => `${r.status}|${r.label}|${r.when}|${r.loc?.file}:${r.loc?.line}`);
  assert.equal(new Set(keys).size, keys.length, keys.join('\n'));
  assert.ok(rows.some((r) => r.status === 500), 'the storage error passes through both rethrows');
});

test('a call expanded earlier keeps the errors a nested rethrow lets through', () => {
  assert.ok(statuses(ep('GET', '/api/v1/review/swallow/:id')).includes(404));
});

test('switch: an empty stacked clause falls through; break leaves the switch', () => {
  const sw = ep('GET', '/api/v1/review/stacked/:k').steps.find((s) => s.kind === 'switch');
  assert.ok(sw && sw.kind === 'switch');
  const labels: string[] = [];
  walk(sw.cases.find((c) => c.label === "'a'")!.body, (s) => 'label' in s && labels.push(s.label));
  assert.ok(labels.includes('ReviewService.load()'), labels.join());
  const e = ep('GET', '/api/v1/review/break/:k');
  const decision = e.graph.nodes.find((n) => n.label === 'k.length > 3 ?')!;
  const after = e.graph.edges.find((x) => x.from === decision.id && x.label === 'yes')!;
  assert.equal(e.graph.nodes.find((n) => n.id === after.to)!.label, 'return 3');
});

test('metadata: handler-only reads ignore class metadata; unresolved decorators leave the decision open', () => {
  const cm = ep('GET', '/api/v1/classmeta');
  assert.ok(response(cm, 401).some((r) => r.when === 'No token'));
  const pkg = ep('GET', '/api/v1/pkgpublic');
  assert.ok(pkg.graph.nodes.some((n) => n.label === 'isPublic ?'), 'not decided when @Public comes from a package');
});

test('request checks apply only to the request object; ALL and wildcard routes stay open', () => {
  const note = ep('POST', '/api/v1/scenario/note');
  assert.ok(response(note, 400).some((r) => r.when === 'Password sessions cannot do this'));
  assert.equal(note.auth?.scheme, 'bearer', 'a 401 thrown in a function the guard calls counts');
  const any = ep('ALL', '/api/v1/review/any');
  assert.ok(response(any, 403).some((r) => /CSRF/.test(r.label + r.when)), 'POST-only check on an ALL route is undecided');
});

test('Passport handleRequest `throw err || new UnauthorizedException()` is a 401', () => {
  assert.ok(response(ep('GET', '/api/v1/canonical'), 401).some((r) => r.when === 'Invalid token'));
});

test('awaited client call is drawn even when its argument is a drawn call', () => {
  assert.ok(ep('GET', '/api/v1/review/upload').graph.nodes.some((n) => /this\.s3Client\.send\(\)/.test(n.label)));
});

test('@Redirect with a returned statusCode', () => {
  assert.deepEqual(ep('GET', '/api/v1/review/go').responses.filter((r) => r.kind === 'success').map((r) => r.status), [308]);
});

test('conditional registration through a variable and the else branch', () => {
  assert.ok(ep('GET', '/api/v1/prodonly').warnings.some((w) => /Registered only when not `process\.env\.NODE_ENV === 'test'`/.test(w)));
});

test('APP_INTERCEPTOR providers run before useGlobalInterceptors', () => {
  const names = ep('GET', '/api/v1/dogs').pipeline.filter((p) => p.kind === 'interceptor').map((p) => p.name.split('(')[0]);
  assert.deepEqual(names.slice(0, 2), ['ProviderInterceptor', 'BootstrapInterceptor']);
});

test('validation: whitelist via an options variable, IsOptional-only fields kept, numeric literals', () => {
  const create = ep('POST', '/api/v1/items');
  assert.ok(field(create, 'memo'), '@IsOptional() alone keeps a field through the whitelist');
  assert.ok(!field(create, 'internal'), 'an undecorated field is stripped');
  assert.deepEqual(field(create, 'amount')!.values, [1000, 2000]);
  assert.deepEqual(field(create, 'offset')!.values, [-16]);
  const parts = openApiParts(app);
  const doc = assembleOpenApi(parts, parts.operations, 'http://h') as any;
  assert.equal(doc.components.schemas.CreateItemDto.properties.slug.pattern, '^[a-z/,]+$');
});

test('examples respect length rules with IsNumberString and simple digit patterns', () => {
  const v = (exportRequests(app).find((r) => r.method === 'POST' && r.path === '/api/v1/items')!.body as any).value;
  assert.match(v.otp, /^\d{6}$/);
  assert.match(v.pin, /^\d{4}$/);
});

test('assembleOpenApi can run repeatedly on the same parts', () => {
  const parts = openApiParts(app);
  const a = JSON.stringify(assembleOpenApi(parts, parts.operations, 'http://h'));
  const b = JSON.stringify(assembleOpenApi(parts, parts.operations, 'http://h'));
  assert.equal(a, b);
});
