/** Data model shared by the analyzer and the renderers. Everything here is plain JSON. */

export type Layer =
  | 'request'
  | 'middleware'
  | 'validation'
  | 'controller'
  | 'service'
  | 'entity'
  | 'external'
  | 'response';

export const LAYERS: { id: Layer; title: string }[] = [
  { id: 'request', title: 'Request' },
  { id: 'middleware', title: 'Middleware, guards, interceptors' },
  { id: 'validation', title: 'Validation (pipes)' },
  { id: 'controller', title: 'Controller' },
  { id: 'service', title: 'Service' },
  { id: 'entity', title: 'Entity / database' },
  { id: 'external', title: 'External / async' },
  { id: 'response', title: 'Response' },
];

export interface Loc {
  file: string;
  line: number;
}

/** A structured description of what a function does, reduced to the parts worth drawing. */
export type Step =
  | { kind: 'action'; layer: Layer; label: string; loc?: Loc }
  | { kind: 'call'; layer: Layer; label: string; body?: Step[]; note?: string; raises?: Raise[]; loc?: Loc }
  | { kind: 'db'; layer: Layer; label: string; entity?: string; op: string; loc?: Loc }
  | { kind: 'external'; layer: Layer; label: string; loc?: Loc }
  | { kind: 'if'; layer: Layer; cond: string; then: Step[]; else?: Step[]; loc?: Loc }
  | { kind: 'switch'; layer: Layer; subject: string; cases: { label: string; body: Step[] }[]; hasDefault: boolean; loc?: Loc }
  | { kind: 'loop'; layer: Layer; label: string; body: Step[]; callback?: boolean; loc?: Loc }
  | { kind: 'try'; layer: Layer; body: Step[]; catchLabel?: string; catchVar?: string; catchBody?: Step[]; finallyBody?: Step[]; loc?: Loc }
  | { kind: 'group'; layer: Layer; label: string; body: Step[]; loc?: Loc }
  | { kind: 'throw'; layer: Layer; exception: string; status?: number; message?: string; rethrow?: string; passThrough?: boolean; loc?: Loc }
  | { kind: 'return'; layer: Layer; expr?: string; verdict?: boolean; loc?: Loc }
  | { kind: 'respond'; layer: Layer; status?: number; label: string; loc?: Loc }
  /** `break` / `continue`: leaves the enclosing switch or loop body. */
  | { kind: 'jump'; layer: Layer; jump: 'break' | 'continue'; loc?: Loc };

/** An exception a function can let escape: kept for call sites that are not expanded again. */
export interface Raise {
  exception: string;
  status?: number;
  message?: string;
  loc?: Loc;
}

export type Shape = 'rect' | 'stadium' | 'sub' | 'decision' | 'db' | 'io' | 'hex';

export interface GNode {
  id: string;
  label: string;
  shape: Shape;
  layer: Layer;
  /** Style class: a layer name, or ok / err / note. */
  cls: string;
  /** The call, guard, middleware or handler node whose body this node belongs to. Responses have none. */
  scope?: string;
  loc?: Loc;
}

export interface GEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

export interface PipelineItem {
  kind: 'middleware' | 'guard' | 'interceptor' | 'pipe' | 'filter';
  name: string;
  scope: 'global' | 'module' | 'controller' | 'route' | 'param';
  note?: string;
  loc?: Loc;
}

export interface FieldRule {
  name: string;
  type: string;
  required: boolean;
  rules: string[];
  /** Allowed values from `@IsEnum()` / `@IsIn()`, when they can be resolved. */
  values?: (string | number | boolean)[];
  /** Class name of a nested DTO (`@Type(() => X)` or the declared type). */
  dto?: string;
  note?: string;
  nested?: FieldRule[];
}

export interface ParamDoc {
  in: 'body' | 'query' | 'param' | 'headers' | 'custom';
  name: string;
  key?: string;
  type: string;
  dto?: string;
  pipes: string[];
  fields: FieldRule[];
  loc?: Loc;
}

export interface EntityDoc {
  name: string;
  table?: string;
  loc?: Loc;
  columns: { name: string; type: string; constraints: string[] }[];
  relations: { name: string; kind: string; target: string }[];
  hooks: { event: string; method: string }[];
  subscribers: string[];
  /** Operations this endpoint performs on the entity. */
  ops: string[];
}

export interface ResponseDoc {
  kind: 'success' | 'error';
  status?: number;
  label: string;
  when: string;
  origin: string;
  loc?: Loc;
}

export interface AuthDoc {
  scheme: 'bearer' | 'basic' | 'cookie' | 'none';
  /** Cookie name, for `cookie`. */
  cookie?: string;
  /** What the scheme was inferred from. */
  source?: string;
}

export interface EndpointDoc {
  id: string;
  kind: 'http' | 'job';
  /** HTTP verb, or JOB / EVENT / CRON / MESSAGE for non-HTTP entry points. */
  method: string;
  path: string;
  group: string;
  handler: string;
  loc: Loc;
  summary?: string;
  metadata: string[];
  pipeline: PipelineItem[];
  auth?: AuthDoc;
  params: ParamDoc[];
  entities: EntityDoc[];
  returnType?: string;
  responseFields?: { name: string; type: string; note?: string }[];
  responses: ResponseDoc[];
  declaredResponses: string[];
  steps: Step[];
  graph: Graph;
  mermaid: { flow: string; flowFlat: string; mindmap: string };
  warnings: string[];
}

export interface AppDoc {
  name: string;
  /** `version` from the app's package.json, used for the OpenAPI document. */
  version?: string;
  generator: string;
  globalPrefix?: string;
  versioning?: string;
  validationPipe?: string;
  endpoints: EndpointDoc[];
  overviewMindmap: string;
  warnings: string[];
}
