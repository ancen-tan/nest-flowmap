import { reason } from '../http';
import { GEdge, GNode, Graph, Layer, Loc, ResponseDoc, Shape, Step } from '../model';

/**
 * How `return` behaves in the function being drawn:
 *  handler    - ends the request with the success response
 *  job        - ends a background job
 *  call       - returns to the caller, the flow continues there
 *  guard      - `true` lets the request through, a falsy value is a 403
 *  middleware - leaves the middleware, the request continues
 */
export type Mode = 'handler' | 'job' | 'call' | 'guard' | 'middleware';

export interface Pending {
  from: string;
  label?: string;
  dashed?: boolean;
}

interface Frame {
  mode: Mode;
  origin: string;
  /** Node that receives exceptions thrown inside an enclosing try block. */
  catchNode?: string;
}

interface Flow {
  /** Paths that fall through to the next statement. */
  next: Pending[];
  /** Paths that left the current function with `return`. */
  ret: Pending[];
}

export class GraphBuilder {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  responses: ResponseDoc[] = [];
  private seq = 0;
  private errors = new Map<string, string>();
  private okEntry?: string;
  /** Node whose body is being drawn; new nodes are recorded as inside it. */
  private scope?: string;

  constructor(
    private o: {
      kind: 'http' | 'job';
      successStatus: number;
      successNote?: string;
      /** Interceptors that also see the handler's result on the way out. */
      postInterceptors: string[];
    },
  ) {}

  graph(): Graph {
    return { nodes: this.nodes, edges: this.edges };
  }

  node(label: string, shape: Shape, layer: Layer, cls: string = layer, loc?: Loc): string {
    const id = `n${++this.seq}`;
    const scope = layer === 'response' ? undefined : this.scope;
    this.nodes.push({ id, label, shape, layer, cls, ...(scope && { scope }), loc });
    return id;
  }

  edge(from: string, to: string, label?: string, dashed?: boolean) {
    if (this.edges.some((e) => e.from === from && e.to === to && e.label === label)) return;
    this.edges.push({ from, to, label, dashed });
  }

  link(pending: Pending[], to: string) {
    for (const p of pending) this.edge(p.from, to, p.label, p.dashed);
  }

  /** The node every successful path ends at (created on first use). */
  success(): string {
    if (this.okEntry) return this.okEntry;
    const { kind, successStatus: status, successNote } = this.o;
    const label = kind === 'job' ? 'Completed' : `${status} ${reason(status)}`.trim() + (successNote ? `\n${successNote}` : '');
    const ok = this.node(label, 'stadium', 'response', 'ok');
    this.responses.push({ kind: 'success', status: kind === 'job' ? undefined : status, label: label.split('\n')[0], when: 'Handler completes', origin: '' });
    let entry = ok;
    if (this.o.postInterceptors.length) {
      // Created lazily from wherever the first return is, but it belongs to no body.
      const inside = this.scope;
      this.scope = undefined;
      entry = this.node(`Interceptors map the result:\n${this.o.postInterceptors.join(', ')}`, 'rect', 'middleware');
      this.scope = inside;
      this.edge(entry, ok);
    }
    return (this.okEntry = entry);
  }

  /** A terminal error response. Identical errors share one node. */
  error(incoming: Pending[], e: { status?: number; exception: string; message?: string; origin: string; loc?: Loc; head?: string }) {
    const key = `${e.status}|${e.head ?? ''}|${e.exception}|${e.message ?? ''}`;
    let id = this.errors.get(key);
    const head =
      e.head ??
      (this.o.kind === 'job'
        ? 'Fails'
        : e.status !== undefined
          ? `${e.status} ${reason(e.status)}`.trim()
          : 'Error propagates (status depends on the error)');
    if (!id) {
      id = this.node(`${head}\n${e.exception}${e.message ? `: ${e.message}` : ''}`, 'stadium', 'response', 'err', e.loc);
      this.errors.set(key, id);
    }
    const status = this.o.kind === 'job' ? undefined : e.status;
    const when = e.message ?? '';
    if (!this.responses.some((r) => r.kind === 'error' && r.status === status && r.label === e.exception && r.when === when && r.origin === e.origin)) {
      this.responses.push({ kind: 'error', status, label: e.exception, when, origin: e.origin, loc: e.loc });
    }
    this.link(incoming, id);
  }

  /**
   * Draws a function body. Returns the dangling paths so the caller can connect what comes next.
   * `owner` is the node the body belongs to (the handler, guard or middleware box), so the viewer
   * can fold the body into it.
   */
  emit(steps: Step[], incoming: Pending[], mode: Mode, origin: string, owner?: string): Flow {
    const outer = this.scope;
    if (owner) this.scope = owner;
    try {
      return this.steps(steps, incoming, { mode, origin });
    } finally {
      this.scope = outer;
    }
  }

  /** Ends an entry function: whatever is still dangling becomes the success response. */
  finish(flow: Flow) {
    const rest = [...flow.next, ...flow.ret];
    if (rest.length) this.link(rest, this.success());
  }

  private steps(steps: Step[], incoming: Pending[], f: Frame): Flow {
    let cur = incoming;
    const ret: Pending[] = [];
    for (const s of steps) {
      if (!cur.length) break; // everything before this point returned or threw
      const r = this.step(s, cur, f);
      cur = r.next;
      ret.push(...r.ret);
    }
    return { next: cur, ret };
  }

  private step(s: Step, cur: Pending[], f: Frame): Flow {
    const through = (id: string): Flow => {
      this.link(cur, id);
      return { next: [{ from: id }], ret: [] };
    };

    switch (s.kind) {
      case 'action':
        return through(this.node(s.label, 'rect', s.layer, s.layer, s.loc));
      case 'db':
        return through(this.node(s.label, 'db', s.layer, s.layer, s.loc));
      case 'external':
        return through(this.node(s.label, 'io', s.layer, s.layer, s.loc));

      case 'call':
      case 'group': {
        const note = s.kind === 'call' && s.note ? `\n(${s.note})` : '';
        const id = this.node(s.label + note, 'sub', s.layer, s.layer, s.loc);
        this.link(cur, id);
        if (!s.body?.length) return { next: [{ from: id }], ret: [] };
        // A function boundary: `return` inside the body resumes here, at the call site.
        const outer = this.scope;
        this.scope = id;
        const inner = this.steps(s.body, [{ from: id }], { mode: 'call', origin: s.kind === 'call' ? s.label.split('\n').pop()! : f.origin, catchNode: f.catchNode });
        this.scope = outer;
        return { next: [...inner.next, ...inner.ret], ret: [] };
      }

      case 'if': {
        const d = this.node(`${s.cond} ?`, 'decision', s.layer, s.layer, s.loc);
        this.link(cur, d);
        const yes = this.steps(s.then, [{ from: d, label: 'yes' }], f);
        const no = s.else ? this.steps(s.else, [{ from: d, label: 'no' }], f) : { next: [{ from: d, label: 'no' }], ret: [] };
        return { next: [...yes.next, ...no.next], ret: [...yes.ret, ...no.ret] };
      }

      case 'switch': {
        const d = this.node(`${s.subject} ?`, 'decision', s.layer, s.layer, s.loc);
        this.link(cur, d);
        const out: Flow = { next: [], ret: [] };
        for (const c of s.cases) {
          const r = this.steps(c.body, [{ from: d, label: c.label }], f);
          out.next.push(...r.next);
          out.ret.push(...r.ret);
        }
        if (!s.hasDefault) out.next.push({ from: d, label: 'otherwise' });
        return out;
      }

      case 'loop': {
        const l = this.node(s.label, 'hex', s.layer, s.layer, s.loc);
        this.link(cur, l);
        const body = this.steps(s.body, [{ from: l, label: 'each' }], s.callback ? { ...f, mode: 'call' } : f);
        const back = s.callback ? [...body.next, ...body.ret] : body.next;
        for (const p of back) this.edge(p.from, l, p.label ?? 'next', true);
        return { next: [{ from: l, label: 'done' }], ret: s.callback ? [] : body.ret };
      }

      case 'try': {
        if (s.catchBody === undefined) {
          const body = this.steps(s.body, cur, f);
          if (!s.finallyBody) return body;
          const fin = this.steps(s.finallyBody, body.next, f);
          return { next: fin.next, ret: [...body.ret, ...fin.ret] };
        }
        const firstNew = this.nodes.length;
        const catchId = this.node(s.catchLabel ?? 'catch', 'rect', s.layer, 'catch', s.loc);
        const body = this.steps(s.body, cur, { ...f, catchNode: catchId });
        // Anything in the try block can fail; hang the catch off its first I/O node, else its first node.
        const added = this.nodes.slice(firstNew + 1);
        const first = added.find((n) => n.shape === 'db' || n.shape === 'io') ?? added[0];
        if (first) this.edge(first.id, catchId, 'on error', true);
        else this.link(cur.map((p) => ({ ...p, dashed: true })), catchId);
        const handler = this.steps(s.catchBody, [{ from: catchId }], f);
        let next = [...body.next, ...handler.next];
        const ret = [...body.ret, ...handler.ret];
        if (s.finallyBody) {
          const fin = this.steps(s.finallyBody, next, f);
          next = fin.next;
          ret.push(...fin.ret);
        }
        return { next, ret };
      }

      case 'throw': {
        if (f.catchNode) {
          const t = this.node(`throw ${s.exception}`, 'rect', s.layer, s.layer, s.loc);
          this.link(cur, t);
          this.edge(t, f.catchNode, 'caught', true);
          return { next: [], ret: [] };
        }
        this.error(cur, { status: s.status, exception: s.exception, message: s.message, origin: f.origin, loc: s.loc });
        return { next: [], ret: [] };
      }

      case 'respond': {
        const status = s.status ?? 200;
        const id = this.node(`${status} ${reason(status)}\nres.${s.label}`.trim(), 'stadium', 'response', status >= 400 ? 'err' : 'ok', s.loc);
        this.link(cur, id);
        this.responses.push({ kind: status >= 400 ? 'error' : 'success', status, label: `res.${s.label}`, when: 'Written directly to the response object', origin: f.origin, loc: s.loc });
        return { next: [], ret: [] };
      }

      case 'return': {
        if (f.mode === 'call' || f.mode === 'middleware') {
          // Returning from a called function: the flow resumes at the call site. When the return sits
          // directly under a decision, say what comes back so the branches stay distinguishable.
          const note = f.mode === 'call' && s.expr && s.expr.length <= 28 && !s.expr.startsWith('result of') ? `returns ${s.expr}` : undefined;
          return { next: [], ret: note ? cur.map((p) => (p.label ? { ...p, label: `${p.label} · ${note}` } : p)) : cur };
        }
        if (f.mode === 'guard') {
          if (s.verdict === true) return { next: [], ret: cur };
          if (s.verdict === false) {
            this.error(cur, { status: 403, exception: 'ForbiddenException', message: 'Forbidden resource', origin: f.origin, loc: s.loc });
            return { next: [], ret: [] };
          }
          const d = this.node(`${s.expr ?? 'returned value'} ?`, 'decision', s.layer, s.layer, s.loc);
          this.link(cur, d);
          this.error([{ from: d, label: 'falsy' }], { status: 403, exception: 'ForbiddenException', message: 'Forbidden resource', origin: f.origin, loc: s.loc });
          return { next: [], ret: [{ from: d, label: 'truthy' }] };
        }
        // handler / job: the request ends here
        if (!s.expr) {
          this.link(cur, this.success());
        } else {
          const r = this.node(`return ${s.expr}`, 'rect', s.layer, s.layer, s.loc);
          this.link(cur, r);
          this.edge(r, this.success());
        }
        return { next: [], ret: [] };
      }
    }
  }
}
