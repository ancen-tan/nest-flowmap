import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { analyze } from '../src/analyze/endpoints';
import { AppDoc, EndpointDoc } from '../src/model';
import { loadProject } from '../src/project';
import { assembleCollection, exportRequests } from '../src/render/collections';
import { VIEWER_LIB } from '../src/render/html';
import { collapseGraph, defaultExpanded, flowchart } from '../src/render/mermaid';
import { assembleOpenApi, openApiParts } from '../src/render/openapi';
import { Graph } from '../src/model';

// Compiled to dist/test, so the package root is two levels up.
const ROOT = path.join(__dirname, '..', '..');

function load(dir: string, depth = 6): AppDoc {
  const root = path.join(ROOT, dir);
  return analyze(loadProject(root, { depth, verbose: false }), path.basename(root));
}

function ep(app: AppDoc, method: string, p: string): EndpointDoc {
  const found = app.endpoints.find((e) => e.method === method && e.path === p);
  assert.ok(found, `missing ${method} ${p}; have ${app.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

const labels = (e: EndpointDoc) => e.graph.nodes.map((n) => n.label);
const has = (e: EndpointDoc, re: RegExp) => labels(e).some((l) => re.test(l));
const statuses = (e: EndpointDoc) => [...new Set(e.responses.map((r) => r.status))].sort();
/** Is there a directed path between the nodes matching `from` and `to`? */
function reaches(e: EndpointDoc, from: RegExp, to: RegExp): boolean {
  const start = e.graph.nodes.filter((n) => from.test(n.label)).map((n) => n.id);
  const goal = new Set(e.graph.nodes.filter((n) => to.test(n.label)).map((n) => n.id));
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    if (goal.has(id) && !start.includes(id)) return true;
    for (const edge of e.graph.edges) {
      if (edge.from === id && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return false;
}

const edge = load('test/fixtures/edge');

test('edge fixture: prefix, header versioning, constant paths, Passport guard', () => {
  assert.equal(edge.globalPrefix, 'api');
  const put = ep(edge, 'PUT', '/api/orders/:id');
  assert.ok(put.metadata.includes('version 2 selected by HEADER'));
  ep(edge, 'GET', '/api/orders/export');
  assert.ok(has(put, /^Passport 'jwt' strategy accepts the credentials \?$/));
  assert.ok(has(put, /^JwtStrategy\.validate\(\)$/));
  assert.ok(put.responses.some((r) => r.status === 401 && r.when === 'Token revoked'));
  assert.ok(put.responses.some((r) => r.status === 429));
});

test('queue and job names declared as constants (widened object, alias import, enum) are resolved', () => {
  ep(edge, 'JOB', "queue 'audit' job 'record'");
  ep(edge, 'JOB', "queue 'reports'");
});

test('edge fixture: custom repository, manual transaction, loops, recursion, raw response', () => {
  const put = ep(edge, 'PUT', '/api/orders/:id');
  assert.ok(has(put, /^OrderRepository\.findOpen\(\)$/));
  assert.ok(has(put, /^Order\.findOne\(\)\nby id, status$/));
  assert.ok(has(put, /^Order\.save\(\)$/));
  assert.ok(has(put, /^OrderService\.reserve\(\)\n\(recursive call\)$/));
  assert.ok(has(put, /^Raw SQL/));
  assert.ok(put.warnings.some((w) => /not declared with @ApiResponse: 400, 401, 429/.test(w)));

  const post = ep(edge, 'POST', '/api/orders');
  assert.ok(has(post, /^for each itemId of dto\.itemIds$/));
  assert.ok(post.responses.some((r) => r.status === 422 && r.label === 'OutOfStockError'));
  assert.ok(reaches(post, /^BEGIN transaction$/, /^COMMIT transaction$/));
  assert.ok(reaches(post, /^catch err$/, /^ROLLBACK transaction$/));
  assert.ok(post.warnings.some((w) => /2 classes implement Notifier/.test(w)));
  assert.ok(post.warnings.some((w) => /no ValidationPipe was found/.test(w)));

  const exp = ep(edge, 'GET', '/api/orders/export');
  assert.deepEqual(statuses(exp).filter((s) => s && s < 400), [200, 302]);
});

test('--depth limits how far calls are followed and says so', () => {
  const shallow = load('test/fixtures/edge', 1);
  const e = ep(shallow, 'PUT', '/api/orders/:id');
  assert.ok(has(e, /^OrderRepository\.findOpen\(\)\n\(not expanded: depth limit\)$/));
  assert.ok(e.warnings.some((w) => /depth limit 1/.test(w)));
});

test('output is deterministic', () => {
  assert.equal(JSON.stringify(load('test/fixtures/edge')), JSON.stringify(edge));
});

test('labels with quotes, angle brackets and backticks are escaped for Mermaid', () => {
  for (const e of edge.endpoints) {
    for (const line of e.mermaid.flow.split('\n')) {
      const m = /^\s+n\d+\S*?"(.*)"\S*$/.exec(line);
      if (m) assert.ok(!/["`<>]/.test(m[1].replace(/<br\/>/g, '')), `unescaped label: ${line}`);
    }
  }
});

test('enum values are resolved for @IsEnum fields', () => {
  const body = ep(edge, 'POST', '/api/orders').params.find((p) => p.in === 'body')!;
  assert.deepEqual(body.fields.find((f) => f.name === 'channel')!.values, ['web', 'app']);
});

test('Postman and Bruno exports cover the HTTP endpoints with examples, path variables and auth', () => {
  const reqs = exportRequests(edge);
  const pm = assembleCollection('postman', edge.name, reqs, 'http://api.test') as any;
  const items = pm.item.flatMap((g: any) => g.item);
  assert.deepEqual(items.map((i: any) => i.name), ['POST /api/orders', 'PUT /api/orders/:id', 'GET /api/orders/export']);
  assert.deepEqual(pm.variable.map((v: any) => [v.key, v.value]), [['baseUrl', 'http://api.test'], ['token', '']]);
  const byName = (n: string) => items.find((i: any) => i.name === n).request;

  const put = byName('PUT /api/orders/:id');
  assert.deepEqual(put.url.variable.map((v: any) => v.key), ['id']);
  assert.equal(put.url.raw, '{{baseUrl}}/api/orders/:id');
  assert.equal(put.auth.type, 'bearer');

  const create = byName('POST /api/orders');
  const body = JSON.parse(create.body.raw);
  assert.equal(body.contact, 'user@example.com');
  assert.equal(body.channel, 'web');
  assert.deepEqual(body.itemIds, [0]);
  assert.deepEqual(Object.keys(body.shipping), ['street', 'postalCode']);
  assert.deepEqual(create.header.map((h: any) => h.key), ['idempotency-key']);

  const bru = assembleCollection('bruno', edge.name, reqs, 'http://api.test') as any;
  const bruItems = bru.items.flatMap((f: any) => f.items);
  assert.equal(bruItems.length, 3);
  const one = bruItems.find((i: any) => i.name === 'PUT /api/orders/:id');
  assert.equal(one.type, 'http');
  assert.deepEqual(one.request.params, [{ name: 'id', value: '', description: 'number · ParseIntPipe', type: 'path', enabled: true }]);
  assert.deepEqual(one.request.auth, { mode: 'bearer', bearer: { token: '{{token}}' } });
  assert.deepEqual(bru.environments[0].variables.map((v: any) => [v.name, v.secret]), [['baseUrl', false], ['token', true]]);
});

test('nodes record the call, guard, middleware or handler body they belong to', () => {
  const e = ep(edge, 'PUT', '/api/orders/:id');
  const byLabel = (re: RegExp) => e.graph.nodes.find((n) => re.test(n.label))!;
  const handler = byLabel(/^OrderController\.update\(\)$/);
  const service = byLabel(/^OrderService\.update\(\)$/);
  assert.equal(handler.scope, undefined);
  assert.equal(service.scope, handler.id);
  assert.equal(byLabel(/^OrderRepository\.findOpen\(\)$/).scope, service.id);
  assert.equal(byLabel(/^Passport 'jwt' strategy/).scope, byLabel(/^Guard: JwtGuard/).id);
  assert.ok(e.graph.nodes.filter((n) => n.layer === 'response').every((n) => !n.scope), 'responses sit outside every body');
});

test('collapsing folds a body into its call and reroutes edges', () => {
  const g: Graph = {
    nodes: [
      { id: 'h', label: 'handler', shape: 'sub', layer: 'controller', cls: 'controller' },
      { id: 'c', label: 'call', shape: 'sub', layer: 'service', cls: 'service', scope: 'h' },
      { id: 'd', label: 'x ?', shape: 'decision', layer: 'service', cls: 'service', scope: 'c' },
      { id: 'l', label: 'loop', shape: 'hex', layer: 'service', cls: 'service', scope: 'c' },
      { id: 'err', label: '400', shape: 'stadium', layer: 'response', cls: 'err' },
      { id: 'next', label: 'next', shape: 'rect', layer: 'service', cls: 'service', scope: 'h' },
    ],
    edges: [
      { from: 'h', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'err', label: 'yes', dashed: true },
      { from: 'd', to: 'l', label: 'no' },
      { from: 'l', to: 'l', label: 'next', dashed: true },
      { from: 'l', to: 'next', label: 'done' },
      { from: 'd', to: 'next', label: 'no' },
    ],
  };
  const folded = collapseGraph(g, ['h']);
  assert.deepEqual(folded.nodes.map((n) => n.id), ['h', 'c', 'err', 'next']);
  assert.equal(folded.nodes[1].label, 'call\n▸ 2 more steps');
  assert.deepEqual(folded.edges, [
    { from: 'h', to: 'c' },
    { from: 'c', to: 'err', dashed: true },
    { from: 'c', to: 'next' },
  ]);
  assert.deepEqual(collapseGraph(g, ['h', 'c']), g, 'fully expanded is unchanged');
  assert.deepEqual(collapseGraph(g, []).nodes.map((n) => n.id), ['h', 'err'], 'folding the handler hides everything inside it');
});

test('error responses caused only inside folded calls merge per status', () => {
  const err = (id: string, label: string) => ({ id, label, shape: 'stadium' as const, layer: 'response' as const, cls: 'err' });
  const g: Graph = {
    nodes: [
      { id: 'h', label: 'handler', shape: 'sub', layer: 'controller', cls: 'controller' },
      { id: 'a', label: 'A()', shape: 'sub', layer: 'service', cls: 'service', scope: 'h' },
      { id: 'a1', label: 'x ?', shape: 'decision', layer: 'service', cls: 'service', scope: 'a' },
      { id: 'b', label: 'B()', shape: 'sub', layer: 'service', cls: 'service', scope: 'h' },
      { id: 'b1', label: 'y ?', shape: 'decision', layer: 'service', cls: 'service', scope: 'b' },
      { id: 'd', label: 'z ?', shape: 'decision', layer: 'controller', cls: 'controller', scope: 'h' },
      err('e1', '422 Unprocessable Entity\nNoUserException: no user'),
      err('e2', '422 Unprocessable Entity\nNoCompanyException: no company'),
      err('e3', '404 Not Found\nNotFoundException: gone'),
      err('e4', '422 Unprocessable Entity\nShownException: visible cause'),
    ],
    edges: [
      { from: 'h', to: 'a' }, { from: 'a', to: 'a1' }, { from: 'a1', to: 'e1', label: 'yes' }, { from: 'a1', to: 'b', label: 'no' },
      { from: 'b', to: 'b1' }, { from: 'b1', to: 'e2', label: 'yes' }, { from: 'b1', to: 'e3', label: 'no' }, { from: 'b', to: 'd' },
      { from: 'd', to: 'e4', label: 'yes' },
    ],
  };
  const v = collapseGraph(g, ['h']);
  assert.deepEqual(v.nodes.filter((n) => n.cls === 'err').map((n) => n.label), [
    '422 Unprocessable Entity · 2 reasons\nNoUserException, NoCompanyException',
    '404 Not Found\nNotFoundException: gone',
    '422 Unprocessable Entity\nShownException: visible cause',
  ]);
  assert.deepEqual(v.edges.filter((e) => e.to === 'e1').map((e) => e.from).sort(), ['a', 'b']);
  assert.equal(collapseGraph(g, ['h', 'a', 'b']).nodes.length, g.nodes.length, 'nothing merges when every cause is visible');
});

test('large diagrams open folded within the node budget, small ones open fully', () => {
  for (const budget of [50, 12]) {
    for (const e of edge.endpoints) {
      const open = defaultExpanded(e.graph, budget);
      const shown = collapseGraph(e.graph, open).nodes.length;
      if (e.graph.nodes.length <= budget) assert.equal(shown, e.graph.nodes.length, `${e.id} should open fully`);
      else assert.ok(shown <= budget || open.length === e.graph.nodes.filter((n) => !n.scope && n.shape === 'sub').length, `${e.id} shows ${shown}`);
    }
  }
});

test('the viewer runs the same flowchart, folding and export code as Node', () => {
  // Inject the sources the way the viewer does: as declarations in one scope.
  const lib = new Function(`${VIEWER_LIB.map((f) => f.toString()).join('\n')}\nreturn { flowchart, collapseGraph, defaultExpanded, assembleCollection, assembleOpenApi };`)();
  for (const e of edge.endpoints) {
    const open = defaultExpanded(e.graph, 12);
    assert.deepEqual(lib.defaultExpanded(e.graph, 12), open);
    assert.equal(lib.flowchart(lib.collapseGraph(e.graph, open), true), flowchart(collapseGraph(e.graph, open), true));
    assert.equal(lib.flowchart(e.graph, false), e.mermaid.flowFlat);
  }
  const reqs = exportRequests(edge).slice(0, 2);
  for (const kind of ['postman', 'bruno'] as const) {
    assert.deepEqual(lib.assembleCollection(kind, 'x', reqs, 'http://h'), assembleCollection(kind, 'x', reqs, 'http://h'));
  }
  const parts = openApiParts(edge);
  assert.deepEqual(lib.assembleOpenApi(parts, parts.operations.slice(0, 2), 'http://h'), assembleOpenApi(parts, parts.operations.slice(0, 2), 'http://h'));
});

test('OpenAPI 3.0.0 document: paths, parameters, DTO schemas with validation rules, responses and security', () => {
  const parts = openApiParts(edge);
  const doc = assembleOpenApi(parts, parts.operations, 'http://api.test') as any;
  assert.equal(doc.openapi, '3.0.0');
  assert.deepEqual(doc.servers, [{ url: 'http://api.test' }]);
  assert.deepEqual(Object.keys(doc.paths), ['/api/orders', '/api/orders/{id}', '/api/orders/export']);

  const put = doc.paths['/api/orders/{id}'].put;
  assert.deepEqual(put.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]);
  assert.deepEqual(put.security, [{ bearerAuth: [] }]);
  assert.deepEqual(doc.components.securitySchemes, { bearerAuth: { type: 'http', scheme: 'bearer' } });
  assert.ok(put.responses['200'] && put.responses['404'] && put.responses['429'], 'success and error statuses');
  assert.match(put.responses['401'].description, /Token revoked/);

  const create = doc.paths['/api/orders'].post;
  assert.deepEqual(create.parameters, [{ name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } }]);
  assert.deepEqual(create.requestBody.content['application/json'].schema, { $ref: '#/components/schemas/CreateOrderDto' });
  const dto = doc.components.schemas.CreateOrderDto;
  assert.deepEqual(dto.required, ['customer', 'contact', 'channel', 'itemIds']);
  assert.equal(dto.properties.contact.format, 'email');
  assert.deepEqual(dto.properties.channel.enum, ['web', 'app']);
  assert.equal(dto.properties.itemIds.type, 'array');
  assert.equal(dto.properties.itemIds.items.type, 'integer');
  assert.deepEqual(dto.properties.shipping.allOf, [{ $ref: '#/components/schemas/AddressDto' }]);
  assert.deepEqual(doc.components.schemas.AddressDto.properties.postalCode, { type: 'string', minLength: 5, maxLength: 5, description: 'Validation: Length(5, 5)' });
  assert.match(create.responses['422'].description, /OutOfStockError/);

  const ids = Object.values(doc.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');

  const one = assembleOpenApi(parts, parts.operations.filter((o) => o.path === '/api/orders/{id}'), 'http://api.test') as any;
  assert.deepEqual(Object.keys(one.components.schemas), ['AddressDto', 'UpdateOrderDto'], 'only the schemas the chosen operations use');
});
