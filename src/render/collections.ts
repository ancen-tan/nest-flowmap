import { AppDoc, EndpointDoc, FieldRule, ParamDoc } from '../model';

/**
 * Postman (v2.1) and Bruno collections for the HTTP endpoints, exported from the viewer.
 * `exportRequests` runs at generation time and reduces each endpoint to a request with example
 * values from the DTO types and class-validator rules, and auth guessed from guard names.
 * `assembleCollection` turns a selection of those into a collection file; the viewer runs its
 * source in the browser, so it must stay self-contained (no references outside its body).
 */

export const DEFAULT_BASE_URL = 'http://localhost:3000';

export type Auth = 'bearer' | 'basic' | 'none';

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
  description: string;
}

export interface ExportRequest {
  id: string;
  group: string;
  method: string;
  name: string;
  /** URL path with `:name` placeholders kept, e.g. /v1/user/:id */
  path: string;
  pathVars: KV[];
  query: KV[];
  headers: KV[];
  body?: { kind: 'json'; value: unknown } | { kind: 'form'; fields: { key: string; file: boolean }[] };
  auth: Auth;
  docs: string;
}

const PRIMITIVE_EXAMPLES: Record<string, unknown> = {
  string: '',
  number: 0,
  bigint: 0,
  boolean: false,
  Date: '2026-01-01T00:00:00.000Z',
  any: null,
  unknown: null,
  object: {},
};

function firstLiteral(text: string): unknown {
  const m = /^\[?\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|(true|false))/.exec(text.trim());
  if (!m) return undefined;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  if (m[3] !== undefined) return Number(m[3]);
  return m[4] === 'true';
}

function ruleArg(rules: string[], name: string): string | undefined {
  const r = rules.find((x) => x.startsWith(`${name}(`));
  return r?.slice(name.length + 1, -1);
}

/** A plausible example for one validated field. Unknown types become a `<TypeName>` placeholder. */
function exampleFor(f: FieldRule): unknown {
  const type = f.type.replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
  const isArray = /\[\]$/.test(type) || /^Array</.test(type) || f.rules.includes('IsArray');
  const base = type.replace(/\[\]$/, '').replace(/^Array<(.*)>$/, '$1');
  const one = scalarExample(f, base);
  return isArray ? [one] : one;
}

function scalarExample(f: FieldRule, base: string): unknown {
  if (f.nested?.length) return objectExample(f.nested);
  const r = f.rules;
  if (f.values?.length) return f.values[0];
  for (const name of ['IsIn', 'Equals']) {
    const arg = ruleArg(r, name);
    const lit = arg === undefined ? undefined : firstLiteral(arg);
    if (lit !== undefined) return lit;
  }
  if (r.includes('IsEmail')) return 'user@example.com';
  if (r.includes('IsUUID')) return '00000000-0000-4000-8000-000000000000';
  if (r.some((x) => /^(IsDateString|IsISO8601|IsDate)\b/.test(x))) return '2026-01-01T00:00:00.000Z';
  if (r.some((x) => /^(IsMobilePhone|IsPhoneNumber)\b/.test(x))) return '+6281234567890';
  if (r.includes('IsNumberString')) return '0';
  if (r.some((x) => /^(IsInt|IsNumber|IsPositive)\b/.test(x)) || base === 'number') {
    const min = Number(ruleArg(r, 'Min'));
    return Number.isFinite(min) ? min : r.includes('IsPositive') ? 1 : 0;
  }
  if (r.includes('IsBoolean')) return false;
  const lit = firstLiteral(base);
  if (lit !== undefined) return lit;
  if (base in PRIMITIVE_EXAMPLES) return PRIMITIVE_EXAMPLES[base];
  return `<${base}>`;
}

function objectExample(fields: FieldRule[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of fields) o[f.name] = exampleFor(f);
  return o;
}

/** Example for a URL or header value: scalars only, placeholders left blank for the user to fill. */
function textExample(f: FieldRule | undefined): string {
  if (!f) return '';
  const v = exampleFor(f);
  if (typeof v === 'string') return v.startsWith('<') ? '' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function describe(f: FieldRule | undefined, fallbackType?: string): string {
  if (!f) return fallbackType ?? '';
  const values = f.values?.length ? `one of ${f.values.join(', ')}` : undefined;
  return [f.type, f.required ? 'required' : 'optional', ...f.rules, values, f.note].filter(Boolean).join(' · ');
}

const camel = (s: string) => s.replace(/[-_]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase());

export function authFor(ep: EndpointDoc): Auth {
  const guards = ep.pipeline.filter((p) => p.kind === 'guard').map((p) => p.name);
  if (guards.some((g) => /basic/i.test(g))) return 'basic';
  if (guards.some((g) => /jwt|bearer|access.?token/i.test(g))) return 'bearer';
  return 'none';
}

export function docsFor(ep: EndpointDoc): string {
  const out: string[] = [];
  if (ep.summary) out.push(ep.summary, '');
  out.push(`Handler: \`${ep.handler}\` (${ep.loc.file}:${ep.loc.line})`);
  if (ep.pipeline.length) {
    out.push('', 'Pipeline:', ...ep.pipeline.map((p) => `- ${p.kind} \`${p.name}\` (${p.scope})${p.note ? ` - ${p.note}` : ''}`));
  }
  const fields = (fs: FieldRule[], prefix = ''): string[] =>
    fs.flatMap((f) => [`- \`${prefix}${f.name}\`: ${describe(f)}`, ...(f.nested ? fields(f.nested, `${prefix}${f.name}.`) : [])]);
  for (const p of ep.params) {
    if (!p.fields.length) continue;
    out.push('', `Validation, ${p.in}${p.key ? ` \`${p.key}\`` : ''} (\`${p.dto ?? p.type}\`):`, ...fields(p.fields));
  }
  if (ep.responses.length) {
    out.push('', 'Responses:', ...ep.responses.map((r) => {
        const status = String(r.status ?? (r.kind === 'success' ? 'ok' : 'varies'));
        const label = r.label.startsWith(status) ? r.label : `${status} ${r.label}`;
        return `- ${label}${r.when ? ` - ${r.when}` : ''}`;
      }));
  }
  if (ep.warnings.length) out.push('', 'Analysis notes:', ...ep.warnings.map((w) => `- ${w}`));
  return out.join('\n');
}

function buildRequest(ep: EndpointDoc): ExportRequest {
  const params = (where: ParamDoc['in']) => ep.params.filter((p) => p.in === where);

  const pathFields = params('param');
  const pathVars = (ep.path.match(/:[A-Za-z0-9_]+/g) ?? []).map((seg) => {
    const name = seg.slice(1);
    const keyed = pathFields.find((p) => p.key === name);
    const field = pathFields.flatMap((p) => p.fields).find((f) => f.name === name || f.name === camel(name));
    return { key: name, value: '', enabled: true, description: field ? describe(field) : keyed ? [keyed.type, ...keyed.pipes].join(' · ') : '' };
  });

  const query: KV[] = [];
  for (const p of params('query')) {
    if (p.key) query.push({ key: p.key, value: '', enabled: true, description: [p.type, ...p.pipes].join(' · ') });
    else for (const f of p.fields) query.push({ key: f.name, value: textExample(f), enabled: f.required, description: describe(f) });
  }

  const headers: KV[] = params('headers')
    .filter((p) => p.key)
    .map((p) => ({ key: p.key!, value: '', enabled: true, description: p.type }));

  let body: ExportRequest['body'];
  const upload = ep.params.find((p) => p.in === 'custom' && /^@UploadedFiles?\(/.test(p.key ?? ''));
  if (upload) {
    const names = ep.pipeline
      .filter((p) => p.kind === 'interceptor')
      .flatMap((p) => [...p.name.matchAll(/name:\s*'([^']+)'|Files?Interceptor\('([^']+)'/g)].map((m) => m[1] ?? m[2]));
    const fields = (names.length ? names : ['file']).map((key) => ({ key, file: true }));
    for (const p of params('body')) for (const f of p.fields) fields.push({ key: f.name, file: false });
    body = { kind: 'form', fields };
  } else if (params('body').length === 1 && !params('body')[0].key && /\[\]$|^Array</.test(params('body')[0].type)) {
    body = { kind: 'json', value: [objectExample(params('body')[0].fields)] };
  } else if (params('body').length) {
    const value: Record<string, unknown> = {};
    for (const p of params('body')) {
      if (p.key) value[p.key] = p.fields.length ? objectExample(p.fields) : exampleFor({ name: p.key, type: p.type, required: true, rules: [] });
      else Object.assign(value, objectExample(p.fields));
    }
    body = { kind: 'json', value };
  }

  return {
    id: ep.id,
    group: ep.group,
    method: ep.method,
    name: `${ep.method} ${ep.path}`,
    path: ep.path,
    pathVars,
    query,
    headers,
    ...(body && { body }),
    auth: authFor(ep),
    docs: docsFor(ep),
  };
}

export function exportRequests(app: AppDoc): ExportRequest[] {
  return app.endpoints.filter((ep) => ep.kind === 'http').map(buildRequest);
}

/** Builds a Postman v2.1 or Bruno collection (JSON import format) from requests, keeping their order. */
export function assembleCollection(kind: 'postman' | 'bruno', name: string, reqs: ExportRequest[], baseUrl: string): object {
  const groups: [string, ExportRequest[]][] = [];
  for (const r of reqs) {
    const g = groups.find((x) => x[0] === r.group);
    if (g) g[1].push(r);
    else groups.push([r.group, [r]]);
  }
  const url = (r: ExportRequest) => {
    const on = r.query.filter((q) => q.enabled);
    return `{{baseUrl}}${r.path}${on.length ? '?' + on.map((q) => `${q.key}=${q.value}`).join('&') : ''}`;
  };
  const secrets: string[] = [];
  if (reqs.some((r) => r.auth === 'bearer')) secrets.push('token');
  if (reqs.some((r) => r.auth === 'basic')) secrets.push('username', 'password');

  if (kind === 'postman') {
    const item = (r: ExportRequest) => {
      const request: Record<string, unknown> = {
        method: r.method,
        header: r.headers.map((h) => ({ key: h.key, value: h.value, description: h.description })),
        url: {
          raw: url(r),
          host: ['{{baseUrl}}'],
          path: r.path.split('/').filter(Boolean),
          ...(r.query.length && { query: r.query.map((q) => ({ key: q.key, value: q.value, description: q.description, ...(!q.enabled && { disabled: true }) })) }),
          ...(r.pathVars.length && { variable: r.pathVars.map((v) => ({ key: v.key, value: v.value, description: v.description })) }),
        },
        description: r.docs,
      };
      if (r.auth === 'bearer') request.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] };
      if (r.auth === 'basic') {
        request.auth = {
          type: 'basic',
          basic: [
            { key: 'username', value: '{{username}}', type: 'string' },
            { key: 'password', value: '{{password}}', type: 'string' },
          ],
        };
      }
      if (r.body?.kind === 'json') request.body = { mode: 'raw', raw: JSON.stringify(r.body.value, null, 2), options: { raw: { language: 'json' } } };
      if (r.body?.kind === 'form') {
        request.body = { mode: 'formdata', formdata: r.body.fields.map((f) => (f.file ? { key: f.key, type: 'file', src: [] } : { key: f.key, value: '', type: 'text' })) };
      }
      return { name: r.name, request, response: [] };
    };
    return {
      info: {
        name,
        description: 'Generated by nest-flowmap from the source code. Example values come from DTO types and validation rules; auth is inferred from guard names.',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: groups.map(([group, rs]) => ({ name: group, item: rs.map(item) })),
      variable: [{ key: 'baseUrl', value: baseUrl, type: 'string' }, ...secrets.map((key) => ({ key, value: '', type: 'string' }))],
    };
  }

  const item = (r: ExportRequest, seq: number) => {
    const auth =
      r.auth === 'bearer'
        ? { mode: 'bearer', bearer: { token: '{{token}}' } }
        : r.auth === 'basic'
          ? { mode: 'basic', basic: { username: '{{username}}', password: '{{password}}' } }
          : { mode: 'none' };
    const body =
      r.body?.kind === 'json'
        ? { mode: 'json', json: JSON.stringify(r.body.value, null, 2) }
        : r.body?.kind === 'form'
          ? { mode: 'multipartForm', multipartForm: r.body.fields.map((f) => ({ type: f.file ? 'file' : 'text', name: f.key, value: f.file ? [] : '', enabled: true })) }
          : { mode: 'none' };
    return {
      type: 'http',
      name: r.name,
      seq,
      request: {
        url: url(r),
        method: r.method,
        headers: r.headers.map((h) => ({ name: h.key, value: h.value, description: h.description, enabled: h.enabled })),
        params: [
          ...r.query.map((q) => ({ name: q.key, value: q.value, description: q.description, type: 'query', enabled: q.enabled })),
          ...r.pathVars.map((v) => ({ name: v.key, value: v.value, description: v.description, type: 'path', enabled: true })),
        ],
        auth,
        body,
        script: {},
        vars: {},
        assertions: [],
        tests: '',
        docs: r.docs,
      },
    };
  };
  return {
    version: '1',
    name,
    items: groups.map(([group, rs], i) => ({ type: 'folder', name: group, seq: i + 1, items: rs.map((r, j) => item(r, j + 1)) })),
    environments: [
      {
        name: 'local',
        variables: [
          { name: 'baseUrl', value: baseUrl, type: 'text', enabled: true, secret: false },
          ...secrets.map((s) => ({ name: s, value: '', type: 'text', enabled: true, secret: true })),
        ],
      },
    ],
    brunoConfig: { version: '1', name, type: 'collection', ignore: ['node_modules', '.git'] },
  };
}
