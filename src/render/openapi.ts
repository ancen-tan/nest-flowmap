import { AppDoc, EndpointDoc, FieldRule, ParamDoc } from '../model';
import { authFor, docsFor } from './collections';

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
  auth: 'bearer' | 'basic' | 'none';
  operation: Record<string, unknown>;
}

export interface OpenApiParts {
  title: string;
  version: string;
  operations: OpenApiOperation[];
  schemas: Record<string, Schema>;
}

const REF = '#/components/schemas/';

/** Literals in a rule argument such as `['A', 'B']`; undefined when the text was cut short. */
function literals(text: string | undefined): (string | number | boolean)[] | undefined {
  if (text === undefined || text.includes('…')) return undefined;
  const out: (string | number | boolean)[] = [];
  const re = /'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|\b(true|false)\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m[1] ?? m[2] ?? (m[3] !== undefined ? Number(m[3]) : m[4] === 'true'));
  }
  return out.length ? out : undefined;
}

function ruleArg(rules: string[], name: string): string | undefined {
  const r = rules.find((x) => x.startsWith(`${name}(`));
  return r?.slice(name.length + 1, -1);
}

function num(text: string | undefined): number | undefined {
  const n = Number(text);
  return text !== undefined && text.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

class SchemaRegistry {
  schemas: Record<string, Schema> = {};
  private keys = new Map<string, string>();

  /** Registers an object schema under a DTO name; a different shape under a taken name gets a suffix. */
  register(name: string, fields: FieldRule[]): string {
    const schema = this.object(fields);
    const key = JSON.stringify(schema);
    const known = this.keys.get(`${name}\n${key}`);
    if (known) return known;
    let unique = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'Schema';
    for (let i = 2; this.schemas[unique]; i++) unique = `${name}_${i}`;
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
    const nullable = /\|\s*null\b/.test(type);
    type = type.replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
    const isArray = /\[\]$/.test(type) || /^Array<.*>$/.test(type) || f.rules.includes('IsArray');
    const base = type.replace(/\[\]$/, '').replace(/^Array<(.*)>$/, '$1').trim();

    const item: Schema = f.nested?.length ? { $ref: REF + this.register(base, f.nested) } : scalar(f, base);
    const r = f.rules;
    let schema: Schema = item;
    if (isArray) {
      schema = { type: 'array', items: item };
      const min = num(ruleArg(r, 'ArrayMinSize'));
      const max = num(ruleArg(r, 'ArrayMaxSize'));
      if (min !== undefined) schema.minItems = min;
      else if (r.includes('ArrayNotEmpty')) schema.minItems = 1;
      if (max !== undefined) schema.maxItems = max;
    }
    const notes = [f.note, r.length ? `Validation: ${r.join(', ')}` : undefined].filter(Boolean).join('. ');
    if (schema.$ref) {
      // Siblings of $ref are ignored in OpenAPI 3.0, so wrap it when there is more to say.
      if (nullable || notes) schema = { allOf: [schema], ...(nullable && { nullable: true }), ...(notes && { description: notes }) };
      return schema;
    }
    if (nullable) schema.nullable = true;
    if (notes) schema.description = notes;
    return schema;
  }
}

/** Schema for one non-object value, from its TypeScript type and class-validator rules. */
function scalar(f: FieldRule, base: string): Schema {
  const r = f.rules;
  const s: Schema = {};
  const allowed = f.values?.length ? f.values : (literals(ruleArg(r, 'IsIn')) ?? literals(ruleArg(r, 'Equals')));
  const unionLiterals = /^('[^']*'|"[^"]*"|-?\d+(\.\d+)?)(\s*\|\s*('[^']*'|"[^"]*"|-?\d+(\.\d+)?))*$/.test(base) ? literals(base) : undefined;
  const values = allowed ?? unionLiterals;

  if (values?.length) {
    s.type = values.every((v) => typeof v === 'number') ? 'number' : values.every((v) => typeof v === 'boolean') ? 'boolean' : 'string';
    s.enum = values;
  } else if (r.some((x) => /^IsInt\b/.test(x))) s.type = 'integer';
  else if (r.some((x) => /^(IsNumber|IsPositive|IsNegative)\b/.test(x)) || base === 'number' || base === 'bigint') s.type = 'number';
  else if (r.includes('IsBoolean') || base === 'boolean') s.type = 'boolean';
  else if (base === 'Date' || r.some((x) => /^(IsDate|IsDateString|IsISO8601)\b/.test(x))) {
    s.type = 'string';
    s.format = 'date-time';
  } else if (base === 'string' || r.some((x) => /^(IsString|IsEmail|IsUUID|IsUrl|IsNumberString|Matches|Length|MinLength|MaxLength)\b/.test(x))) s.type = 'string';
  else if (/^(object|Record<.*>|\{.*\})$/.test(base) || r.includes('IsObject')) s.type = 'object';
  else if (base && base !== 'any' && base !== 'unknown') s.description = `TypeScript type: ${base}`;

  if (r.includes('IsEmail')) s.format = 'email';
  if (r.some((x) => /^IsUUID\b/.test(x))) s.format = 'uuid';
  if (r.some((x) => /^IsUrl\b/.test(x))) s.format = 'uri';
  if (r.includes('IsNumberString')) s.pattern = '^-?\\d+(\\.\\d+)?$';
  const match = /^\/(.*)\/[a-z]*$/.exec((ruleArg(r, 'Matches') ?? '').split(/,\s*\{/)[0].trim());
  if (match && !match[1].includes('…')) s.pattern = match[1];

  const len = ruleArg(r, 'Length')?.split(',').map((x) => num(x));
  const minLength = num(ruleArg(r, 'MinLength')) ?? len?.[0];
  const maxLength = num(ruleArg(r, 'MaxLength')) ?? len?.[1];
  if (minLength !== undefined) s.minLength = minLength;
  else if (s.type === 'string' && r.includes('IsNotEmpty')) s.minLength = 1;
  if (maxLength !== undefined) s.maxLength = maxLength;
  const min = num(ruleArg(r, 'Min'));
  const max = num(ruleArg(r, 'Max'));
  if (min !== undefined) s.minimum = min;
  else if (r.includes('IsPositive')) Object.assign(s, { minimum: 0, exclusiveMinimum: true });
  if (max !== undefined) s.maximum = max;
  return s;
}

/** Schema for a parameter typed directly on the handler, e.g. `@Param('id', ParseIntPipe) id: number`. */
function paramSchema(p: ParamDoc | undefined): Schema {
  if (!p) return { type: 'string' };
  if (p.pipes.some((x) => /^Parse(Int|Float)Pipe/.test(x))) return { type: /Int/.test(p.pipes.join()) ? 'integer' : 'number' };
  if (p.pipes.some((x) => /^ParseUUIDPipe/.test(x))) return { type: 'string', format: 'uuid' };
  if (p.pipes.some((x) => /^ParseBoolPipe/.test(x))) return { type: 'boolean' };
  return scalar({ name: p.key ?? p.name, type: p.type, required: true, rules: [] }, p.type.replace(/\s*\|\s*(null|undefined)\b/g, ''));
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
  for (const p of of('headers')) if (p.key) parameters.push({ name: p.key, in: 'header', required: true, schema: { type: 'string' } });

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

  const auth = authFor(ep);
  const operation: Record<string, unknown> = {
    tags: [ep.group],
    summary: ep.summary ?? `${ep.method} ${ep.path}`,
    description: docsFor(ep),
    operationId,
    ...(parameters.length && { parameters }),
    ...(requestBody && { requestBody }),
    responses,
    ...(auth === 'bearer' && { security: [{ bearerAuth: [] }] }),
    ...(auth === 'basic' && { security: [{ basicAuth: [] }] }),
  };
  return { id: ep.id, path, method: ep.method.toLowerCase(), auth, operation };
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function openApiParts(app: AppDoc): OpenApiParts {
  const reg = new SchemaRegistry();
  const used = new Set<string>();
  const operations = app.endpoints.filter((ep) => ep.kind === 'http' && METHODS.has(ep.method.toLowerCase())).map((ep) => operationFor(ep, reg, used));
  return { title: app.name, version: app.version ?? '1.0.0', operations, schemas: reg.schemas };
}

/** An OpenAPI 3.0.0 document for the given operations, with only the schemas they use. */
export function assembleOpenApi(parts: OpenApiParts, operations: OpenApiOperation[], serverUrl: string): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) (paths[op.path] ??= {})[op.method] = op.operation;

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
  if (operations.some((o) => o.auth === 'bearer')) securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer' };
  if (operations.some((o) => o.auth === 'basic')) securitySchemes.basicAuth = { type: 'http', scheme: 'basic' };
  const tags = [...new Set(operations.map((o) => (o.operation.tags as string[])[0]))].map((name) => ({ name }));

  return {
    openapi: '3.0.0',
    info: {
      title: parts.title,
      version: parts.version,
      description:
        'Generated by nest-flowmap from the source code. Schemas come from the DTOs and their class-validator rules, responses from the exceptions each handler can reach, and security from guard names.',
    },
    servers: [{ url: serverUrl }],
    tags,
    paths,
    components: { schemas: sorted, ...(Object.keys(securitySchemes).length && { securitySchemes }) },
  };
}
