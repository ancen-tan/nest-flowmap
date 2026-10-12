import { AppDoc, AuthDoc, EndpointDoc, FieldRule, ParamDoc } from '../model';
import { docsFor } from './collections';
import { hasRule, isEach, matchesPattern, numArg, ruleArgs } from './rules';

/**
 * OpenAPI 3.0.0 description of the HTTP endpoints. `openApiParts` runs at generation time and turns
 * each endpoint into an operation, with DTO schemas collected once under `components.schemas`.
 * `assembleOpenApi` builds a document from a selection of operations; the viewer runs its source in
 * the browser, so it must stay self-contained (no references outside its body).
 */

type Schema = Record<string, unknown>;

export interface OpenApiOperation {
  /** Endpoint id, so the viewer can export the endpoints matching its filter. */
  id: string;
  /** Path in OpenAPI form, e.g. /v1/user/{id} */
  path: string;
  method: string;
  auth: AuthDoc;
  operation: Record<string, unknown>;
}

export interface OpenApiParts {
  title: string;
  version: string;
  operations: OpenApiOperation[];
  schemas: Record<string, Schema>;
  /** Routes with a method OpenAPI has no field for (`@All`, `@Search`). */
  skipped: string[];
}

const REF = '#/components/schemas/';

/** Literals in an array literal's text such as `['A', 'B']`; undefined when the text was cut short. */
function literals(text: string | undefined): (string | number | boolean)[] | undefined {
  if (text === undefined || text.includes('…') || !/^\[.*\]$/.test(text.trim())) return undefined;
  const out: (string | number | boolean)[] = [];
  const re = /'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|\b(true|false)\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m[1] ?? m[2] ?? (m[3] !== undefined ? Number(m[3]) : m[4] === 'true'));
  }
  return out.length ? out : undefined;
}

const SAFE_KEY = /[^A-Za-z0-9._-]/g;

class SchemaRegistry {
  schemas: Record<string, Schema> = {};
  private keys = new Map<string, string>();

  /** Registers an object schema under a DTO name; a different shape under a taken name gets a suffix. */
  register(name: string, fields: FieldRule[]): string {
    const schema = this.object(fields);
    const key = JSON.stringify(schema);
    const known = this.keys.get(`${name}\n${key}`);
    if (known) return known;
    const base = name.replace(SAFE_KEY, '_') || 'Schema';
    let unique = base;
    for (let i = 2; this.schemas[unique]; i++) unique = `${base}_${i}`;
    this.schemas[unique] = schema;
    this.keys.set(`${name}\n${key}`, unique);
    return unique;
  }

  object(fields: FieldRule[]): Schema {
    const properties: Record<string, Schema> = {};
    for (const f of fields) properties[f.name] = this.field(f);
    const required = fields.filter((f) => f.required).map((f) => f.name);
    return { type: 'object', properties, ...(required.length && { required }) };
  }

  field(f: FieldRule): Schema {
    let type = f.type.trim();
    // `| null` is only accepted when the field is optional: @IsOptional lets null through, other rules reject it.
    const nullable = /\|\s*null\b/.test(type) && !f.required;
    type = type.replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
    const isArray = /\[\]$/.test(type) || /^Array<.*>$/.test(type) || hasRule(f.rules, 'IsArray');
    const base = type.replace(/\[\]$/, '').replace(/^Array<(.*)>$/, '$1').trim();
    const r = f.rules;

    // On an array, rules declared with { each: true } describe the items; the others describe the array.
    const itemRules = isArray ? r.filter(isEach) : r;
    const item: Schema = f.nested?.length ? { $ref: REF + this.register(f.dto ?? base, f.nested) } : scalar({ ...f, rules: itemRules }, base);
    let schema: Schema = item;
    if (isArray) {
      schema = { type: 'array', items: item };
      const min = numArg(r, 'ArrayMinSize');
      const max = numArg(r, 'ArrayMaxSize');
      if (min !== undefined) schema.minItems = min;
      else if (hasRule(r, 'ArrayNotEmpty')) schema.minItems = 1;
      if (max !== undefined) schema.maxItems = max;
    }
    const notes = [f.note, r.length ? `Validation: ${r.join(', ')}` : undefined].filter(Boolean).join('. ');
    if (schema.$ref) {
      // Siblings of $ref are ignored in OpenAPI 3.0, so wrap it when there is more to say.
      if (nullable || notes) schema = { allOf: [schema], ...(nullable && { nullable: true }), ...(notes && { description: notes }) };
      return schema;
    }
    if (nullable && schema.type) schema.nullable = true;
    if (notes) schema.description = notes;
    return schema;
  }
}

/** Schema for one non-object value, from its TypeScript type and class-validator rules. */
function scalar(f: FieldRule, base: string): Schema {
  const r = f.rules;
  const s: Schema = {};
  const unionLiterals = /^('[^']*'|"[^"]*"|-?\d+(\.\d+)?)(\s*\|\s*('[^']*'|"[^"]*"|-?\d+(\.\d+)?))*$/.test(base) ? literals(`[${base.replace(/\|/g, ',')}]`) : undefined;
  const values = f.values?.length ? f.values : (literals(ruleArgs(r, 'IsIn')?.[0]) ?? unionLiterals);

  if (values?.length) {
    const kinds = new Set(values.map((v) => typeof v));
    if (kinds.size === 1) s.type = kinds.has('number') ? 'number' : kinds.has('boolean') ? 'boolean' : 'string';
    s.enum = values;
  } else if (hasRule(r, 'IsNumberString')) {
    s.type = 'string';
    s.pattern = '^-?\\d+(\\.\\d+)?$';
  } else if (hasRule(r, 'IsInt')) s.type = 'integer';
  else if (hasRule(r, 'IsNumber') || hasRule(r, 'IsPositive') || hasRule(r, 'IsNegative') || base === 'number' || base === 'bigint') s.type = 'number';
  else if (hasRule(r, 'IsBoolean') || base === 'boolean') s.type = 'boolean';
  else if (hasRule(r, 'IsDateString') || hasRule(r, 'IsISO8601')) {
    // class-validator accepts dates and date-times here, so no `format`.
    s.type = 'string';
  } else if (base === 'Date' || hasRule(r, 'IsDate')) {
    s.type = 'string';
    s.format = 'date-time';
  } else if (base === 'string' || ['IsString', 'IsEmail', 'IsUUID', 'IsUrl', 'Matches', 'Length', 'MinLength', 'MaxLength', 'IsNotEmpty'].some((x) => hasRule(r, x))) s.type = 'string';
  else if (/^(object|Record<.*>|\{.*\})$/.test(base) || hasRule(r, 'IsObject')) s.type = 'object';
  else if (base && base !== 'any' && base !== 'unknown') s.description = `TypeScript type: ${base}`;

  if (hasRule(r, 'IsEmail')) s.format = 'email';
  if (hasRule(r, 'IsUUID')) s.format = 'uuid';
  if (hasRule(r, 'IsUrl')) s.format = 'uri';
  const pattern = matchesPattern(r);
  if (pattern !== undefined) s.pattern = pattern;

  if (s.type === 'string') {
    const minLength = numArg(r, 'MinLength') ?? numArg(r, 'Length', 0);
    const maxLength = numArg(r, 'MaxLength') ?? numArg(r, 'Length', 1);
    if (minLength !== undefined) s.minLength = minLength;
    else if (hasRule(r, 'IsNotEmpty')) s.minLength = 1;
    if (maxLength !== undefined) s.maxLength = maxLength;
  }
  if (s.type === 'number' || s.type === 'integer') {
    const min = numArg(r, 'Min');
    const max = numArg(r, 'Max');
    if (min !== undefined) s.minimum = min;
    else if (hasRule(r, 'IsPositive')) Object.assign(s, { minimum: 0, exclusiveMinimum: true });
    if (max !== undefined) s.maximum = max;
  }
  return s;
}

/** Schema for a parameter typed directly on the handler, e.g. `@Param('id', ParseIntPipe) id: number`. */
function paramSchema(p: ParamDoc | undefined): Schema {
  if (!p) return { type: 'string' };
  if (p.pipes.some((x) => /^Parse(Int|Float)Pipe/.test(x))) return { type: /Int/.test(p.pipes.join()) ? 'integer' : 'number' };
  if (p.pipes.some((x) => /^ParseUUIDPipe/.test(x))) return { type: 'string', format: 'uuid' };
  if (p.pipes.some((x) => /^ParseBoolPipe/.test(x))) return { type: 'boolean' };
  const s = scalar({ name: p.key ?? p.name, type: p.type, required: true, rules: [] }, p.type.replace(/\s*\|\s*(null|undefined)\b/g, ''));
  // Path, query and header values arrive as strings unless a pipe converts them.
  return s.type || s.enum ? s : { type: 'string' };
}

const camel = (s: string) => s.replace(/[-_]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase());

function operationFor(ep: EndpointDoc, reg: SchemaRegistry, usedIds: Set<string>): OpenApiOperation {
  const of = (where: ParamDoc['in']) => ep.params.filter((p) => p.in === where);
  const parameters: Schema[] = [];

  const pathParams = of('param');
  const path = ep.path.replace(/:([A-Za-z0-9_]+)\??/g, (_, name: string) => {
    const keyed = pathParams.find((p) => p.key === name);
    const field = pathParams.flatMap((p) => p.fields).find((f) => f.name === name || f.name === camel(name));
    const schema = field ? reg.field(field) : paramSchema(keyed);
    const { description, ...rest } = schema;
    parameters.push({ name, in: 'path', required: true, schema: rest, ...(description ? { description } : {}) });
    return `{${name}}`;
  });

  for (const p of of('query')) {
    if (p.key) parameters.push({ name: p.key, in: 'query', required: false, schema: paramSchema(p) });
    for (const f of p.key ? [] : p.fields) {
      const { description, ...schema } = reg.field(f);
      parameters.push({ name: f.name, in: 'query', required: f.required, schema, ...(description ? { description } : {}) });
    }
  }
  // Nest does not require headers; a handler that needs one checks it itself.
  for (const p of of('headers')) if (p.key) parameters.push({ name: p.key, in: 'header', required: false, schema: paramSchema(p) });

  let requestBody: Schema | undefined;
  const bodies = of('body');
  const upload = ep.params.find((p) => p.in === 'custom' && /^@UploadedFiles?\(/.test(p.key ?? ''));
  if (upload) {
    const names = ep.pipeline
      .filter((p) => p.kind === 'interceptor')
      .flatMap((p) => [...p.name.matchAll(/name:\s*'([^']+)'|Files?Interceptor\('([^']+)'/g)].map((m) => m[1] ?? m[2]));
    const properties: Record<string, Schema> = {};
    for (const n of names.length ? names : ['file']) properties[n] = { type: 'string', format: 'binary' };
    for (const p of bodies) for (const f of p.fields) properties[f.name] = reg.field(f);
    requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties } } } };
  } else if (bodies.length) {
    let schema: Schema;
    const single = bodies.length === 1 && !bodies[0].key ? bodies[0] : undefined;
    if (single && single.fields.length) {
      const ref = { $ref: REF + reg.register(single.dto ?? single.type.replace(/\[\]$/, ''), single.fields) };
      schema = /\[\]$|^Array</.test(single.type) ? { type: 'array', items: ref } : ref;
    } else if (single) {
      schema = { type: 'object', description: `TypeScript type: ${single.type}` };
    } else {
      const properties: Record<string, Schema> = {};
      for (const p of bodies) {
        if (p.key) properties[p.key] = p.fields.length ? { $ref: REF + reg.register(p.dto ?? p.type, p.fields) } : paramSchema(p);
        else Object.assign(properties, (reg.object(p.fields).properties as Record<string, Schema>) ?? {});
      }
      schema = { type: 'object', properties };
    }
    requestBody = { required: true, content: { 'application/json': { schema } } };
  }

  // One response per status; each lists every reason the analysis found for it.
  const responses: Record<string, Schema> = {};
  const byStatus = new Map<string, string[]>();
  for (const r of ep.responses) {
    const key = r.status ? String(r.status) : r.kind === 'success' ? '200' : 'default';
    const line = r.kind === 'success' ? r.label : `${r.label}${r.when ? `: ${r.when}` : ''}`;
    byStatus.set(key, [...(byStatus.get(key) ?? []), line]);
  }
  if (!byStatus.size) byStatus.set('default', ['Not determined by the analysis']);
  const success = ep.responses.find((r) => r.kind === 'success' && r.status);
  for (const [status, lines] of [...byStatus].sort(([a], [b]) => (a === 'default' ? 1 : b === 'default' ? -1 : Number(a) - Number(b)))) {
    const unique = [...new Set(lines)];
    const description = unique.length === 1 ? unique[0] : unique.map((l) => `- ${l}`).join('\n');
    const res: Schema = { description: description || 'Response' };
    if (success && status === String(success.status) && status !== '204') {
      if (ep.responseFields?.length) {
        const fields: FieldRule[] = ep.responseFields.map((f) => ({ name: f.name, type: f.type, required: false, rules: [], ...(f.note && { note: f.note }) }));
        res.content = { 'application/json': { schema: reg.object(fields) } };
      } else if (ep.returnType && !/^(Promise<)?void>?$/.test(ep.returnType)) {
        res.content = { 'application/json': { schema: { description: `TypeScript type: ${ep.returnType}` } } };
      }
    }
    responses[status] = res;
  }

  let operationId = ep.handler.replace(/\(\)$/, '').replace(/[^A-Za-z0-9]+/g, '_');
  for (let i = 2; usedIds.has(operationId); i++) operationId = `${ep.handler.replace(/\(\)$/, '').replace(/[^A-Za-z0-9]+/g, '_')}_${i}`;
  usedIds.add(operationId);

  const auth: AuthDoc = ep.auth ?? { scheme: 'none' };
  const operation: Record<string, unknown> = {
    tags: [ep.group],
    summary: ep.summary ?? `${ep.method} ${ep.path}`,
    description: docsFor(ep),
    operationId,
    ...(parameters.length && { parameters }),
    ...(requestBody && { requestBody }),
    responses,
    ...(auth.scheme !== 'none' && { security: [{ [`${auth.scheme}Auth`]: [] }] }),
  };
  return { id: ep.id, path, method: ep.method.toLowerCase(), auth, operation };
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function openApiParts(app: AppDoc): OpenApiParts {
  const reg = new SchemaRegistry();
  const used = new Set<string>();
  const http = app.endpoints.filter((ep) => ep.kind === 'http');
  const operations = http.filter((ep) => METHODS.has(ep.method.toLowerCase())).map((ep) => operationFor(ep, reg, used));
  const skipped = http.filter((ep) => !METHODS.has(ep.method.toLowerCase())).map((ep) => `${ep.method} ${ep.path}`);
  return { title: app.name, version: app.version ?? '1.0.0', operations, schemas: reg.schemas, skipped };
}

/** An OpenAPI 3.0.0 document for the given operations, with only the schemas they use. */
export function assembleOpenApi(parts: OpenApiParts, operations: OpenApiOperation[], serverUrl: string): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const at = (paths[op.path] ??= {});
    const existing = at[op.method] as Record<string, unknown> | undefined;
    // Two handlers for one route (e.g. modules loaded conditionally): keep the first, say so. Copy rather
    // than edit, because the viewer assembles from the same parts on every export.
    if (existing) at[op.method] = { ...existing, description: `${existing.description}\n\nAlso declared by ${String(op.operation.operationId)}.` };
    else at[op.method] = op.operation;
  }

  // Keep the schemas reachable from the chosen operations.
  const schemas: Record<string, unknown> = {};
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === '$ref' && typeof x === 'string' && x.startsWith('#/components/schemas/')) {
          const name = x.slice('#/components/schemas/'.length);
          if (!(name in schemas) && parts.schemas[name]) {
            schemas[name] = parts.schemas[name];
            visit(parts.schemas[name]);
          }
        } else visit(x);
      }
    }
  };
  visit(operations.map((o) => o.operation));
  const sorted: Record<string, unknown> = {};
  for (const name of Object.keys(schemas).sort()) sorted[name] = schemas[name];

  const securitySchemes: Record<string, unknown> = {};
  if (operations.some((o) => o.auth.scheme === 'bearer')) securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer' };
  if (operations.some((o) => o.auth.scheme === 'basic')) securitySchemes.basicAuth = { type: 'http', scheme: 'basic' };
  const cookie = operations.find((o) => o.auth.scheme === 'cookie');
  if (cookie) {
    securitySchemes.cookieAuth = {
      type: 'apiKey',
      in: 'cookie',
      name: cookie.auth.cookie ?? 'session',
      description: cookie.auth.cookie ? `Session cookie, checked by ${cookie.auth.source}.` : `Session cookie, checked by ${cookie.auth.source}. Its name was not found in the code.`,
    };
  }
  const tags = [...new Set(operations.map((o) => (o.operation.tags as string[])[0]))].map((name) => ({ name }));

  return {
    openapi: '3.0.0',
    info: {
      title: parts.title,
      version: parts.version,
      description:
        'Generated by nest-flowmap from the source code. Schemas come from the DTOs and their class-validator rules, responses from the exceptions each handler can reach, and security from the guards and middleware that check credentials.' +
        (parts.skipped?.length ? `\n\nNot included, because OpenAPI has no field for their method: ${parts.skipped.join(', ')}.` : ''),
    },
    servers: [{ url: serverUrl }],
    tags,
    paths,
    components: { schemas: sorted, ...(Object.keys(securitySchemes).length && { securitySchemes }) },
  };
}
