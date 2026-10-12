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

/** An exception that reached a catch (or finally) node, kept so a later `throw e` can re-raise it. */
interface Caught {
  status?: number;
  exception: string;
  message?: string;
  origin: string;
  loc?: Loc;
}

interface Frame {
  mode: Mode;
  origin: string;
  /** Node that receives exceptions thrown inside an enclosing try block. */
  catchNode?: string;
  /** Collects what reaches `catchNode`. */
  caught?: Caught[];
  /** Catch variables in scope and what they may hold. */
  rethrowVars?: Map<string, Caught[]>;
}

interface Flow {
  /** Paths that fall through to the next statement. */
  next: Pending[];
  /** Paths that left the current function with `return`. */
  ret: Pending[];
  /** Paths that hit `break` (leave the enclosing switch or loop). */
  brk?: Pending[];
  /** Paths that hit `continue` (back to the enclosing loop). */
  cont?: Pending[];
}

export class GraphBuilder {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  responses: ResponseDoc[] = [];
  private seq = 0;
  private errors = new Map<string, string>();
  private okEntry?: string;
  /** I/O nodes whose failure is already attributed to an inner try block. */
  private attributed = new Set<string>();
  /** Node whose body is being drawn; new nodes are recorded as inside it. */
  private scope?: string;

  constructor(
    private o: {
      kind: 'http' | 'job';
      successStatus: number;
      successNote?: string;
      /** Interceptors that also see the handler's result on the way out. */
      postInterceptors: string[];
      /** Exception filters that answer some exceptions with their own status. */
      remap?: (exception: string) => { status: number; filter: string } | undefined;
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
    const mapped = this.o.remap?.(e.exception);
    if (mapped && mapped.status !== e.status) e = { ...e, status: mapped.status, head: undefined, origin: `${e.origin}, answered by ${mapped.filter}` };
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
    // One row per throw site: an error re-raised through several catch blocks is still one error.
    const site = (l?: Loc) => (l ? `${l.file}:${l.line}` : '');
    const same = (r: ResponseDoc) =>
      r.kind === 'error' && r.status === status && r.label === e.exception && r.when === when && (e.loc && r.loc ? site(r.loc) === site(e.loc) : r.origin === e.origin);
    if (!this.responses.some(same)) {
      this.responses.push({ kind: 'error', status, label: e.exception, when, origin: e.origin, loc: e.loc });
    }
    this.link(incoming, id);
  }

  /** Sends exceptions on: to the enclosing catch when there is one, else to their error responses. */
  private raise(incoming: Pending[], list: Caught[], f: Frame) {
    if (!incoming.length) return;
    for (const c of list) {
      if (f.catchNode) {
        for (const p of incoming) this.edge(p.from, f.catchNode, 'caught', true);
        f.caught?.push(c);
      } else {
        this.error(incoming, { status: c.status, exception: c.exception, message: c.message, origin: c.origin, loc: c.loc });
      }
    }
  }

  private drop(id: string) {
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
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
    const brk: Pending[] = [];
    const cont: Pending[] = [];
    for (const s of steps) {
      if (!cur.length) break; // everything before this point returned, threw or jumped
      const r = this.step(s, cur, f);
      cur = r.next;
      ret.push(...r.ret);
      brk.push(...(r.brk ?? []));
      cont.push(...(r.cont ?? []));
    }
    return { next: cur, ret, brk, cont };
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
        if (s.kind === 'call' && s.raises?.length) {
          // Drawn without its body (expanded earlier): still show what it can throw.
          this.raise([{ from: id, dashed: true }], s.raises.map((r) => ({ ...r, origin: s.label.split('\n')[0] })), f);
        }
        if (!s.body?.length) return { next: [{ from: id }], ret: [] };
        // A function boundary: `return` inside the body resumes here, at the call site.
        const outer = this.scope;
        this.scope = id;
        const inner = this.steps(s.body, [{ from: id }], {
          mode: 'call',
          origin: s.kind === 'call' ? s.label.split('\n').pop()! : f.origin,
          catchNode: f.catchNode,
          caught: f.caught,
        });
        this.scope = outer;
        return { next: [...inner.next, ...inner.ret], ret: [] };
      }

      case 'if': {
        const d = this.node(`${s.cond} ?`, 'decision', s.layer, s.layer, s.loc);
        this.link(cur, d);
        const yes = this.steps(s.then, [{ from: d, label: 'yes' }], f);
        const no: Flow = s.else ? this.steps(s.else, [{ from: d, label: 'no' }], f) : { next: [{ from: d, label: 'no' }], ret: [] };
        return { next: [...yes.next, ...no.next], ret: [...yes.ret, ...no.ret], brk: [...(yes.brk ?? []), ...(no.brk ?? [])], cont: [...(yes.cont ?? []), ...(no.cont ?? [])] };
      }

      case 'switch': {
        const d = this.node(`${s.subject} ?`, 'decision', s.layer, s.layer, s.loc);
        this.link(cur, d);
        const out: Flow = { next: [], ret: [], cont: [] };
        for (const c of s.cases) {
          const r = this.steps(c.body, [{ from: d, label: c.label }], f);
          // `break` leaves the switch; `continue` belongs to an enclosing loop.
          out.next.push(...r.next, ...(r.brk ?? []));
          out.ret.push(...r.ret);
          out.cont!.push(...(r.cont ?? []));
        }
        if (!s.hasDefault) out.next.push({ from: d, label: 'otherwise' });
        return out;
      }

      case 'loop': {
        const l = this.node(s.label, 'hex', s.layer, s.layer, s.loc);
        this.link(cur, l);
        const body = this.steps(s.body, [{ from: l, label: 'each' }], s.callback ? { ...f, mode: 'call' } : f);
        const back = s.callback ? [...body.next, ...body.ret] : [...body.next, ...(body.cont ?? [])];
        for (const p of back) this.edge(p.from, l, p.label ?? 'next', true);
        // `break` leaves the loop the same way the loop ends.
        return { next: [{ from: l, label: 'done' }, ...(body.brk ?? []).map((p) => ({ ...p, label: p.label ? `${p.label} · break` : 'break' }))], ret: s.callback ? [] : body.ret };
      }

      case 'try': {
        if (s.catchBody === undefined) {
          if (!s.finallyBody) return this.steps(s.body, cur, f);
          // try/finally: an exception runs the finally block, then keeps propagating.
          const caught: Caught[] = [];
          const finNode = this.node('exception: run finally, then rethrow', 'rect', s.layer, 'catch', s.loc);
          const body = this.steps(s.body, cur, { ...f, catchNode: finNode, caught });
          if (caught.length) {
            const errFin = this.steps(s.finallyBody, [{ from: finNode }], f);
            this.raise(errFin.next, caught, f);
          } else {
            this.drop(finNode);
          }
          const fin = this.steps(s.finallyBody, body.next, f);
          let ret = body.ret;
          if (ret.length) {
            const rf = this.steps(s.finallyBody, ret, f);
            ret = [...rf.next, ...rf.ret];
          }
          return { next: fin.next, ret: [...ret, ...fin.ret], brk: body.brk, cont: body.cont };
        }
        const firstNew = this.nodes.length;
        const catchId = this.node(s.catchLabel ?? 'catch', 'rect', s.layer, 'catch', s.loc);
        const caught: Caught[] = [];
        const body = this.steps(s.body, cur, { ...f, catchNode: catchId, caught });
        // Anything in the try block can fail; hang the catch off its first I/O node, else its first node.
        const added = this.nodes.slice(firstNew + 1);
        const first = added.find((n) => n.shape === 'db' || n.shape === 'io') ?? added[0];
        if (first) this.edge(first.id, catchId, 'on error', true);
        else this.link(cur.map((p) => ({ ...p, dashed: true })), catchId);
        // Errors from I/O are not exceptions the code throws itself; a rethrow passes them on as they are.
        // Database and network errors are plain errors, which Nest answers with 500; a project call drawn
        // without its body could throw anything.
        const io = added.find((n) => (n.shape === 'db' || n.shape === 'io') && !this.attributed.has(n.id));
        const opaque = added.find((n) => n.shape === 'sub' && /\((not expanded|body not found)/.test(n.label) && !this.attributed.has(n.id));
        if (io) {
          this.attributed.add(io.id);
          caught.push({ status: 500, exception: `error from ${io.label.split('\n')[0]}`, origin: f.origin, loc: io.loc });
        }
        if (opaque) {
          this.attributed.add(opaque.id);
          caught.push({ exception: `error from ${opaque.label.split('\n')[0]}`, origin: f.origin, loc: opaque.loc });
        }
        const vars = new Map(f.rethrowVars ?? []);
        if (s.catchVar) vars.set(s.catchVar, caught);
        const handler = this.steps(s.catchBody, [{ from: catchId }], { ...f, rethrowVars: vars });
        let next = [...body.next, ...handler.next];
        const ret = [...body.ret, ...handler.ret];
        if (s.finallyBody) {
          const fin = this.steps(s.finallyBody, next, f);
          next = fin.next;
          ret.push(...fin.ret);
        }
        return { next, ret, brk: [...(body.brk ?? []), ...(handler.brk ?? [])], cont: [...(body.cont ?? []), ...(handler.cont ?? [])] };
      }

      case 'throw': {
        if (s.passThrough) {
          // `.catch(e => { log(e); throw e })`: the original error goes on unchanged and is documented where it is thrown.
          const t = this.node(`rethrow ${s.rethrow} (same error)`, 'rect', s.layer, 'note', s.loc);
          this.link(cur, t);
          return { next: [], ret: [] };
        }
        const known = s.rethrow ? f.rethrowVars?.get(s.rethrow) : undefined;
        if (known?.length) {
          // `throw e` in a catch block: whatever reached the catch leaves again, with its own status.
          const t = this.node(`throw ${s.rethrow}`, 'rect', s.layer, s.layer, s.loc);
          this.link(cur, t);
          this.raise([{ from: t }], known, f);
          return { next: [], ret: [] };
        }
        if (f.catchNode) {
          const t = this.node(`throw ${s.exception}`, 'rect', s.layer, s.layer, s.loc);
          this.link(cur, t);
          this.edge(t, f.catchNode, 'caught', true);
          f.caught?.push({ status: s.status, exception: s.exception, message: s.message, origin: f.origin, loc: s.loc });
          return { next: [], ret: [] };
        }
        this.error(cur, { status: s.status, exception: s.exception, message: s.message, origin: f.origin, loc: s.loc });
        return { next: [], ret: [] };
      }

      case 'jump':
        return s.jump === 'break' ? { next: [], ret: [], brk: cur } : { next: [], ret: [], cont: cur };

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
