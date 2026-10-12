import { CallExpression, ClassDeclaration, Identifier, Node, Statement, SyntaxKind } from 'ts-morph';
import { NEST_EXCEPTIONS } from '../http';
import { Layer, Step } from '../model';
import {
  Callable,
  Ctx,
  Dep,
  classLayer,
  findCallable,
  getDeps,
  isFunctionNode,
  lineage,
  literalText,
  locOf,
  objectProp,
  oneLine,
  repositoryEntity,
  resolveClass,
  resolveIdentifier,
  statusOf,
  trunc,
  unwrap,
} from '../project';
import { entityHooks, hooksForOp, isEntity } from './entities';

/** Per-endpoint bookkeeping shared by every function walked for that endpoint. */
export interface Scope {
  warnings: Set<string>;
  expanded: Map<string, number>;
  entityOps: Map<ClassDeclaration, Set<string>>;
}

/** Where queue jobs and events are consumed, so producers can point at their consumers. */
export interface Consumers {
  processors: Map<string, string[]>;
  listeners: Map<string, string[]>;
}

interface DbVar {
  entity?: ClassDeclaration;
  qb?: boolean;
}

interface W {
  cls?: ClassDeclaration;
  layer: Layer;
  depth: number;
  stack: string[];
  /** Names bound to the raw response object (`@Res() res`, middleware `res`). */
  res: Set<string>;
  /** Local variables known to hold a query builder, entity manager or query runner. */
  dbVars: Map<string, DbVar>;
  /** Steps that stand in for `super.canActivate()` in a Passport guard. */
  passport?: Step[];
}

interface Seg {
  name: string;
  call?: CallExpression;
}

interface Classified {
  steps: Step[];
  /** True when the call's callback arguments were already walked. */
  handled?: boolean;
  /** True for the generic "some awaited call" node, which is dropped when it only wraps drawn calls. */
  fallback?: boolean;
}

const ITERATORS = new Set(['forEach', 'map', 'flatMap', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex']);
const QB_BUILDERS = new Set([
  'createQueryBuilder', 'select', 'addSelect', 'from', 'where', 'andWhere', 'orWhere', 'having', 'andHaving', 'orHaving',
  'leftJoin', 'leftJoinAndSelect', 'innerJoin', 'innerJoinAndSelect', 'leftJoinAndMapOne', 'leftJoinAndMapMany',
  'orderBy', 'addOrderBy', 'groupBy', 'addGroupBy', 'skip', 'take', 'limit', 'offset', 'setParameter', 'setParameters',
  'setLock', 'withDeleted', 'distinct', 'distinctOn', 'set', 'values', 'into', 'returning', 'onConflict', 'orUpdate',
  'orIgnore', 'whereInIds', 'andWhereInIds', 'relation', 'of', 'cache', 'comment', 'useTransaction', 'loadRelationCountAndMap',
  'insert', 'update', 'delete', 'softDelete', 'restore', 'clone', 'subQuery', 'getQuery', 'getSql', 'getParameters',
  'createQueryRunner', 'getRepository', 'getTreeRepository', 'withRepository', 'getMetadata',
]);
/** Builder verbs that are executors when called straight on a repository or manager. */
const DIRECT_WRITES = new Set(['insert', 'update', 'delete', 'softDelete', 'restore']);
const NON_DB = new Set(['create', 'merge', 'hasId', 'getId', 'connect', 'release', 'isTransactionActive']);
const TX: Record<string, string> = {
  startTransaction: 'BEGIN transaction',
  commitTransaction: 'COMMIT transaction',
  rollbackTransaction: 'ROLLBACK transaction',
};
const CRITERIA_OPS = /^(find|count|exist|delete|softDelete|restore|update|increment|decrement|sum|average|minimum|maximum)/;
const DB_VAR_NAMES = /^(manager|entityManager|em|trx|tx|queryRunner|qr|qb|queryBuilder|transactionalEntityManager)$/;
const RESPONSE_SENDERS = new Set(['json', 'send', 'end', 'sendStatus', 'redirect', 'render', 'download', 'sendFile']);
const IGNORED_ROOTS = new Set([
  'Promise', 'Object', 'Array', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Date', 'console', 'Symbol', 'Reflect',
  'Buffer', 'process', 'setTimeout', 'setImmediate', 'clearTimeout', 'parseInt', 'parseFloat', 'next', 'require',
]);

export class FlowWalker {
  constructor(
    private ctx: Ctx,
    private consumers: Consumers,
    private scope: Scope,
  ) {}

  /** Walks one entry function (handler, guard, middleware, job processor). */
  entry(fn: Callable, cls: ClassDeclaration | undefined, layer: Layer, extra: { res?: string[]; passport?: Step[] } = {}): Step[] {
    const key = `${cls?.getName() ?? ''}.${Node.isMethodDeclaration(fn) ? fn.getName() : 'fn'}()`;
    return this.fn(fn, {
      cls,
      layer,
      depth: 0,
      stack: [key],
      res: new Set(extra.res ?? []),
      dbVars: new Map(),
      passport: extra.passport,
    });
  }

  private fn(fn: Callable, w: W): Step[] {
    const body = fn.getBody();
    if (!body) return [];
    if (Node.isBlock(body)) return this.stmts(body.getStatements(), w);
    return this.calls(body, w);
  }

  private child(w: W): W {
    return { ...w, dbVars: new Map(w.dbVars) };
  }

  private stmts(list: Statement[], w: W): Step[] {
    return list.flatMap((s) => this.stmt(s, w));
  }

  private stmt(s: Node, w: W): Step[] {
    const layer = w.layer;
    const loc = locOf(this.ctx, s);

    if (Node.isBlock(s)) return this.stmts(s.getStatements(), w);

    if (Node.isIfStatement(s)) {
      const pre = this.calls(s.getExpression(), w, true);
      const then = this.stmt(s.getThenStatement(), w);
      const elseNode = s.getElseStatement();
      const els = elseNode ? this.stmt(elseNode, w) : [];
      if (!then.length && !els.length) return pre;
      return [...pre, { kind: 'if', layer, cond: trunc(s.getExpression().getText(), 70), then, else: els.length ? els : undefined, loc }];
    }

    if (Node.isSwitchStatement(s)) {
      const pre = this.calls(s.getExpression(), w, true);
      const cases: { label: string; body: Step[] }[] = [];
      let pending: string[] = [];
      let hasDefault = false;
      for (const clause of s.getClauses()) {
        const label = Node.isCaseClause(clause) ? trunc(clause.getExpression().getText(), 30) : 'default';
        if (label === 'default') hasDefault = true;
        pending.push(label);
        if (!clause.getStatements().length) continue; // stacked `case a: case b:`
        cases.push({ label: pending.join(' / '), body: this.stmts(clause.getStatements(), w) });
        pending = [];
      }
      if (!cases.some((c) => c.body.length)) return pre;
      return [...pre, { kind: 'switch', layer, subject: trunc(s.getExpression().getText(), 50), cases, hasDefault, loc }];
    }

    if (Node.isForOfStatement(s) || Node.isForInStatement(s)) {
      const pre = this.calls(s.getExpression(), w);
      const body = this.stmt(s.getStatement(), w);
      if (!body.length) return pre;
      const item = oneLine(s.getInitializer().getText()).replace(/^(const|let|var)\s+/, '');
      const word = Node.isForOfStatement(s) ? 'of' : 'in';
      return [...pre, { kind: 'loop', layer, label: trunc(`for each ${item} ${word} ${s.getExpression().getText()}`, 60), body, loc }];
    }

    if (Node.isForStatement(s) || Node.isWhileStatement(s) || Node.isDoStatement(s)) {
      const cond = Node.isForStatement(s) ? s.getCondition() : s.getExpression();
      const pre = this.calls(cond, w, true);
      const body = this.stmt(s.getStatement(), w);
      if (!body.length) return pre;
      return [...pre, { kind: 'loop', layer, label: trunc(`loop while ${cond?.getText() ?? 'true'}`, 60), body, loc }];
    }

    if (Node.isTryStatement(s)) {
      const body = this.stmts(s.getTryBlock().getStatements(), w);
      const clause = s.getCatchClause();
      const catchBody = clause ? this.stmts(clause.getBlock().getStatements(), w) : undefined;
      const fin = s.getFinallyBlock();
      const finallyBody = fin ? this.stmts(fin.getStatements(), w) : [];
      if (!body.length) return finallyBody;
      const v = clause?.getVariableDeclaration()?.getName();
      const swallowed = clause && !catchBody?.length;
      return [
        {
          kind: 'try',
          layer,
          body,
          catchLabel: clause ? `catch ${v ?? 'error'}${swallowed ? ' (handled, flow continues)' : ''}` : undefined,
          catchBody,
          finallyBody: finallyBody.length ? finallyBody : undefined,
          loc,
        },
      ];
    }

    if (Node.isThrowStatement(s)) {
      const pre = this.calls(s.getExpression(), w);
      const e = unwrap(s.getExpression());
      if (Node.isNewExpression(e)) {
        const args = e.getArguments();
        return [
          ...pre,
          {
            kind: 'throw',
            layer,
            exception: e.getExpression().getText(),
            status: this.exceptionStatus(e.getExpression(), args),
            message: this.exceptionMessage(e.getExpression(), args),
            loc,
          },
        ];
      }
      return [...pre, { kind: 'throw', layer, exception: `rethrow ${trunc(e.getText(), 30)}`, loc }];
    }

    if (Node.isReturnStatement(s)) {
      const e = s.getExpression();
      if (!e) return [{ kind: 'return', layer, loc }];
      const u = unwrap(e);
      if (w.passport && Node.isCallExpression(u) && /^super\.canActivate$/.test(u.getExpression().getText())) {
        return [...w.passport, { kind: 'return', layer, verdict: true, loc }];
      }
      const pre = this.calls(e, w);
      if (pre.some((p) => p.kind === 'respond')) return pre;
      const verdict = u.getKind() === SyntaxKind.TrueKeyword ? true : u.getKind() === SyntaxKind.FalseKeyword ? false : undefined;
      let expr = trunc(e.getText(), 48);
      if (Node.isCallExpression(u) && pre.length) {
        const last = [...pre].reverse().find((p) => p.kind === 'call' || p.kind === 'db' || p.kind === 'external' || p.kind === 'group');
        if (last && 'label' in last) expr = `result of ${last.label.split('\n')[0]}`;
      }
      return [...pre, { kind: 'return', layer, expr, verdict, loc }];
    }

    if (Node.isVariableStatement(s)) {
      const steps: Step[] = [];
      for (const d of s.getDeclarations()) {
        const init = d.getInitializer();
        if (!init) continue;
        steps.push(...this.calls(init, w));
        const u = unwrap(init);
        if (Node.isCallExpression(u) && Node.isIdentifier(d.getNameNode())) {
          const info = this.dbChain(u, w);
          const names = info?.segs.map((x) => x.name) ?? [];
          const last = names[names.length - 1] ?? '';
          const qb = !!info?.qb || names.includes('createQueryBuilder');
          if (info && QB_BUILDERS.has(last) && (qb || !DIRECT_WRITES.has(last))) {
            w.dbVars.set(d.getName(), { entity: this.entityIn(info.segs, info.entity, false), qb });
          }
        }
      }
      return steps.length ? steps : this.other(s, w);
    }

    if (Node.isExpressionStatement(s)) {
      const steps = this.calls(s.getExpression(), w);
      return steps.length ? steps : this.other(s, w);
    }

    if (Node.isFunctionDeclaration(s) || Node.isClassDeclaration(s) || Node.isBreakStatement(s) || Node.isContinueStatement(s)) {
      return [];
    }
    if (Node.isLabeledStatement(s)) return this.stmt(s.getStatement(), w);
    return this.calls(s, w);
  }

  private other(s: Node, w: W): Step[] {
    if (!this.ctx.opts.verbose) return [];
    return [{ kind: 'action', layer: w.layer, label: trunc(s.getText().replace(/;$/, ''), 60), loc: locOf(this.ctx, s) }];
  }

  // -------------------------------------------------------------------------------------------
  // Calls

  /** Every call in an expression that is worth drawing, in evaluation order. */
  private calls(node: Node | undefined, w: W, condition = false): Step[] {
    if (!node) return [];
    const found: CallExpression[] = [];
    const visit = (n: Node) => {
      if (isFunctionNode(n) || Node.isFunctionDeclaration(n) || Node.isClassDeclaration(n) || Node.isClassExpression(n)) return;
      if (Node.isCallExpression(n) && !isInnerLink(n)) found.push(n);
      n.forEachChild(visit);
    };
    visit(node);
    found.sort((a, b) => a.getEnd() - b.getEnd());
    const drawn: CallExpression[] = [];
    const out: Step[] = [];
    for (const c of found) {
      const r = this.classify(c, w);
      const steps = r.handled ? r.steps : [...r.steps, ...this.callbacks(c, w)];
      // `await firstValueFrom(this.http.post(...))`: the wrapper adds nothing once the inner call is drawn.
      if (r.fallback && drawn.some((d) => d.getPos() >= c.getPos() && d.getEnd() <= c.getEnd())) continue;
      // In a condition the decision node already shows the call.
      if (r.fallback && condition) continue;
      if (steps.length) drawn.push(c);
      out.push(...steps);
    }
    return out;
  }

  private callbacks(call: CallExpression, w: W): Step[] {
    const out: Step[] = [];
    for (const arg of call.getArguments()) {
      if (!isFunctionNode(arg)) continue;
      const body = this.fn(arg, this.child(w));
      if (!body.length) continue;
      const callee = call.getExpression();
      const loc = locOf(this.ctx, call);
      if (Node.isPropertyAccessExpression(callee) && ITERATORS.has(callee.getName())) {
        out.push({ kind: 'loop', layer: w.layer, label: `for each item of ${trunc(callee.getExpression().getText(), 30)}`, body, callback: true, loc });
      } else {
        out.push({ kind: 'group', layer: w.layer, label: `${trunc(callee.getText(), 40)}(…) callback`, body, loc });
      }
    }
    return out;
  }

  private classify(call: CallExpression, w: W): Classified {
    const { root, segs } = chainOf(call);
    const loc = locOf(this.ctx, call);

    // Raw response object: res.status(401).json(...)
    if (Node.isIdentifier(root) && w.res.has(root.getText())) {
      const sender = segs.find((s) => RESPONSE_SENDERS.has(s.name));
      if (!sender) return { steps: [] };
      const statusSeg = segs.find((s) => s.name === 'status' || s.name === 'sendStatus' || s.name === 'redirect');
      let status = statusOf(statusSeg?.call?.getArguments()[0]);
      if (status === undefined) status = sender.name === 'redirect' ? 302 : 200;
      const arg = sender.call?.getArguments()[0];
      return { steps: [{ kind: 'respond', layer: w.layer, status, label: `${sender.name}(${arg ? trunc(arg.getText(), 44) : ''})`, loc }] };
    }

    const db = this.dbChain(call, w);
    if (db) return this.dbStep(db, call, w);

    if (root.getKind() === SyntaxKind.SuperKeyword && w.cls) {
      const first = segs[0];
      if (!first?.call) return { steps: [] };
      if (w.passport && first.name === 'canActivate') return { steps: w.passport };
      const target = findCallable(this.ctx, w.cls, first.name, 'base');
      if (!target) return { steps: [] };
      return { steps: this.expand(target.owner, target.fn, `${target.owner.getName()}.${first.name}()`, w.layer, w, call, true) };
    }

    if (Node.isThisExpression(root) && w.cls) {
      const first = segs[0];
      if (!first) return { steps: [] };
      if (first.call) {
        const target = findCallable(this.ctx, w.cls, first.name);
        if (!target) return { steps: [] };
        return { steps: this.expand(target.owner, target.fn, `${w.cls.getName()}.${first.name}()`, w.layer, w, call, true) };
      }
      const dep = getDeps(this.ctx, w.cls).get(first.name);
      const rest = segs.slice(1);
      if (!dep || !rest.length) return { steps: [] };
      return { steps: this.depCall(dep, rest, call, w) };
    }

    if (Node.isIdentifier(root)) {
      const name = root.getText();
      if (IGNORED_ROOTS.has(name)) return { steps: [] };
      if (name === 'fetch' || name === 'axios') {
        const verb = segs[0]?.name ? segs[0].name.toUpperCase() : name === 'fetch' ? 'fetch' : 'request';
        const url = call.getArguments()[0];
        return { steps: [{ kind: 'external', layer: 'external', label: `HTTP ${verb} ${url ? trunc(url.getText(), 40) : ''}`.trim(), loc }] };
      }
      const decl = resolveIdentifier(this.ctx, root);
      if (!segs.length && decl) {
        if (Node.isFunctionDeclaration(decl) && decl.getBody()) {
          return { steps: this.expand(undefined, decl, `${name}()`, w.layer, w, call, true) };
        }
        if (Node.isVariableDeclaration(decl) && isFunctionNode(decl.getInitializer())) {
          return { steps: this.expand(undefined, decl.getInitializer() as Callable, `${name}()`, w.layer, w, call, true) };
        }
      }
      if (segs.length === 1 && segs[0].call && decl && Node.isClassDeclaration(decl)) {
        const m = decl.getStaticMethod(segs[0].name);
        if (m?.getBody()) {
          return { steps: this.expand(decl, m, `${name}.${segs[0].name}()`, classLayer(this.ctx, decl), w, call, true) };
        }
      }
    }

    // Anything else: keep awaited calls (they usually do I/O), drop synchronous helpers.
    if (isAwaited(call) || this.ctx.opts.verbose) {
      const text = call.getExpression().getText();
      if (/^(this\.)?(logger|log)\b/i.test(text)) return { steps: [] };
      return { steps: [{ kind: 'action', layer: w.layer, label: `${trunc(text, 44)}()`, loc }], fallback: true };
    }
    return { steps: [] };
  }

  private depCall(dep: Dep, rest: Seg[], call: CallExpression, w: W): Step[] {
    const loc = locOf(this.ctx, call);
    const m = rest[0];
    const arg0 = m.call?.getArguments()[0];
    switch (dep.kind) {
      case 'ignore':
        return [];
      case 'queue': {
        const queue = dep.queue ?? dep.name;
        if (m.name !== 'add' && m.name !== 'addBulk') {
          return this.ctx.opts.verbose ? [{ kind: 'external', layer: 'external', label: `Queue '${queue}'.${m.name}()`, loc }] : [];
        }
        const job = literalText(arg0);
        const consumers = this.consumers.processors.get(queue) ?? [];
        const label = `Enqueue job${job ? ` '${job}'` : 's'} on queue '${queue}'` + (consumers.length ? `\nasync → ${consumers.join(', ')}` : '');
        return [{ kind: 'external', layer: 'external', label, loc }];
      }
      case 'events': {
        if (!/^emit(Async)?$/.test(m.name)) return [];
        const event = literalText(arg0) ?? trunc(arg0?.getText() ?? '?', 30);
        const listeners = this.consumers.listeners.get(event) ?? [];
        const label = `Emit event '${event}'` + (listeners.length ? `\n→ ${listeners.join(', ')}` : '');
        return [{ kind: 'external', layer: 'external', label, loc }];
      }
      case 'http': {
        const verb = /^(get|post|put|patch|delete|head|request)$/.test(m.name) ? m.name.toUpperCase() : `${m.name}()`;
        return [{ kind: 'external', layer: 'external', label: `HTTP ${verb} ${arg0 ? trunc(arg0.getText(), 40) : ''}`.trim(), loc }];
      }
      case 'client':
        return [{ kind: 'external', layer: 'external', label: `Message ${m.name}(${arg0 ? trunc(arg0.getText(), 30) : ''})`, loc }];
      case 'class': {
        if (!m.call || !dep.cls) return [];
        const target = findCallable(this.ctx, dep.cls, m.name);
        const label = `${dep.cls.getName()}.${m.name}()`;
        const layer = classLayer(this.ctx, dep.cls);
        if (target) return this.expand(target.owner, target.fn, label, layer, w, call, false);
        return [{ kind: 'call', layer, label, note: 'body not found', loc }];
      }
      default: {
        if (!m.call) return [];
        const label = `${dep.name}.${rest.map((r) => r.name).join('.')}()`;
        if (dep.note) this.scope.warnings.add(`Could not follow \`${label}\`: ${dep.note}.`);
        return [{ kind: 'external', layer: 'external', label: dep.typeText ? `${label}\n(${trunc(dep.typeText, 40)})` : label, loc }];
      }
    }
  }

  /** Inlines a project function at its call site, with recursion, depth and repetition guards. */
  private expand(owner: ClassDeclaration | undefined, fn: Callable, label: string, layer: Layer, w: W, at: Node, dropIfEmpty: boolean): Step[] {
    const loc = locOf(this.ctx, at);
    if (w.stack.includes(label)) return [{ kind: 'call', layer, label, note: 'recursive call', loc }];
    if (w.depth >= this.ctx.opts.depth) {
      this.scope.warnings.add(`Stopped following calls at \`${label}\` (depth limit ${this.ctx.opts.depth}; raise it with --depth).`);
      return [{ kind: 'call', layer, label, note: 'not expanded: depth limit', loc }];
    }
    const body = this.fn(fn, {
      cls: owner,
      layer,
      depth: w.depth + 1,
      stack: [...w.stack, label],
      res: new Set(),
      dbVars: new Map(),
    });
    if (dropIfEmpty && body.every((b) => b.kind === 'return')) return [];
    const seen = this.scope.expanded.get(label) ?? 0;
    this.scope.expanded.set(label, seen + 1);
    if (seen > 0 && countSteps(body) > 3) return [{ kind: 'call', layer, label, note: 'expanded earlier in this diagram', loc }];
    return [{ kind: 'call', layer, label, body, loc }];
  }

  // -------------------------------------------------------------------------------------------
  // Database access

  /** Recognises a call chain rooted at a repository, entity manager, data source or query builder. */
  private dbChain(call: CallExpression, w: W): { entity?: ClassDeclaration; qb?: boolean; segs: Seg[] } | undefined {
    const { root, segs } = chainOf(call);
    if (Node.isThisExpression(root) && w.cls && segs.length > 1 && !segs[0].call) {
      const dep = getDeps(this.ctx, w.cls).get(segs[0].name);
      if (!dep) return undefined;
      const rest = segs.slice(1);
      if (dep.kind === 'repo' || dep.kind === 'manager' || dep.kind === 'datasource') return { entity: dep.entity, segs: rest };
      // A custom repository class: inherited TypeORM methods are database calls, its own methods are followed.
      if (dep.kind === 'class' && dep.cls && dep.entity && !findCallable(this.ctx, dep.cls, rest[0].name)) {
        return { entity: dep.entity, segs: rest };
      }
      return undefined;
    }
    if (Node.isThisExpression(root) && w.cls && segs.length && segs[0].call) {
      // `this.find()` inside a class that extends Repository<T>
      const entity = repositoryEntity(this.ctx, w.cls);
      if (entity && !findCallable(this.ctx, w.cls, segs[0].name)) return { entity, segs };
      return undefined;
    }
    if (Node.isIdentifier(root) && segs.length) {
      const v = this.dbVar(root, w);
      if (v) return { entity: v.entity, qb: v.qb, segs };
    }
    return undefined;
  }

  /** `manager.save(User, ...)`, `dataSource.getRepository(User)`: the entity is named in an argument. */
  private entityIn(segs: Seg[], fallback: ClassDeclaration | undefined, includeLast: boolean): ClassDeclaration | undefined {
    let entity = fallback;
    const last = segs[segs.length - 1];
    for (const s of segs) {
      if (!s.call) continue;
      if ((includeLast && s === last) || /^(getRepository|getTreeRepository|withRepository|createQueryBuilder|from|into)$/.test(s.name)) {
        const c = resolveClass(this.ctx, s.call.getArguments()[0]);
        if (isEntity(c)) entity = c;
      }
    }
    return entity;
  }

  private dbVar(root: Identifier, w: W): DbVar | undefined {
    const name = root.getText();
    const known = w.dbVars.get(name);
    if (known) return known;
    if (DB_VAR_NAMES.test(name)) return { qb: /^(qb|queryBuilder)$/.test(name) };
    try {
      const t = root.getType().getText();
      if (/\b(EntityManager|QueryRunner|SelectQueryBuilder|Repository)\b/.test(t)) return { qb: /QueryBuilder/.test(t) };
    } catch {
      /* unresolved type */
    }
    return undefined;
  }

  private dbStep(info: { entity?: ClassDeclaration; qb?: boolean; segs: Seg[] }, call: CallExpression, w: W): Classified {
    const { segs } = info;
    const loc = locOf(this.ctx, call);
    const names = segs.map((s) => s.name);
    const last = segs[segs.length - 1];

    const tx = segs.find((s) => s.name === 'transaction' && s.call);
    if (tx) {
      const cb = tx.call!.getArguments().find(isFunctionNode);
      if (!cb) return { steps: [{ kind: 'action', layer: 'entity', label: 'DB transaction', loc }] };
      const child = this.child(w);
      const param = cb.getParameters()[0];
      if (param) child.dbVars.set(param.getName(), {});
      return {
        steps: [
          { kind: 'group', layer: 'entity', label: 'BEGIN transaction\n(rolls back if anything inside throws)', body: this.fn(cb, child), loc },
          { kind: 'action', layer: 'entity', label: 'COMMIT transaction', loc },
        ],
        handled: true,
      };
    }

    if (!last.call) return { steps: [] };
    const op = last.name;
    if (TX[op]) return { steps: [{ kind: 'action', layer: 'entity', label: TX[op], loc }] };
    const viaQb = !!info.qb || names.includes('createQueryBuilder');
    if (NON_DB.has(op)) return { steps: [] };
    if (QB_BUILDERS.has(op) && (viaQb || !DIRECT_WRITES.has(op))) return { steps: [] };

    const entity = this.entityIn(segs, info.entity, true);
    const args = last.call.getArguments();
    let label: string;
    if (op === 'query') {
      label = `Raw SQL\n${trunc(args[0]?.getText() ?? '', 44)}`;
    } else if (viaQb) {
      label = `${entity?.getName() ?? 'Query builder'}: query builder ${op}()`;
    } else {
      label = `${entity ? `${entity.getName()}.` : ''}${op}()`;
      const rest = args[0] && isEntity(resolveClass(this.ctx, args[0])) ? args.slice(1) : args;
      const keys = CRITERIA_OPS.test(op) ? whereKeys(rest[0]) : [];
      if (keys.length) label += `\nby ${trunc(keys.join(', '), 40)}`;
    }

    const steps: Step[] = [];
    const dbNode: Step = { kind: 'db', layer: 'entity', label, entity: entity?.getName(), op, loc };
    if (entity) {
      let ops = this.scope.entityOps.get(entity);
      if (!ops) this.scope.entityOps.set(entity, (ops = new Set()));
      ops.add(op);
      const wanted = hooksForOp(op);
      const hooks = entityHooks(this.ctx, entity);
      const hookStep = (event: string): Step[] =>
        hooks
          .filter((h) => h.event === event)
          .map((h) => ({
            kind: 'call' as const,
            layer: 'entity' as const,
            label: `@${event}\n${entity!.getName()}.${h.method.getName()}()`,
            body: this.fn(h.method, { cls: h.owner, layer: 'entity', depth: w.depth + 1, stack: w.stack, res: new Set(), dbVars: new Map() }),
            loc: locOf(this.ctx, h.method),
          }));
      steps.push(...wanted.before.flatMap(hookStep), dbNode, ...wanted.after.flatMap(hookStep));
    } else {
      steps.push(dbNode);
    }
    return { steps };
  }

  // -------------------------------------------------------------------------------------------
  // Exceptions

  /** The message a thrown exception carries: its own argument, or what a project exception class passes to super(). */
  private exceptionMessage(nameNode: Node, args: Node[]): string | undefined {
    const cls = resolveClass(this.ctx, nameNode);
    for (const c of cls ? lineage(this.ctx, cls) : []) {
      for (const ctor of c.getConstructors()) {
        for (const sup of ctor.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          if (sup.getExpression().getKind() !== SyntaxKind.SuperKeyword) continue;
          const first = sup.getArguments()[0];
          const u = first ? unwrap(first) : undefined;
          if (u && (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u) || Node.isTemplateExpression(u) || Node.isObjectLiteralExpression(u))) {
            return messageText(u);
          }
        }
        // The class has its own constructor, so the caller's arguments are not the message.
        return undefined;
      }
    }
    return args[0] ? messageText(args[0]) : undefined;
  }

  private exceptionStatus(nameNode: Node, args: Node[]): number | undefined {
    const name = nameNode.getText().split('.').pop() ?? '';
    if (NEST_EXCEPTIONS[name]) return NEST_EXCEPTIONS[name];
    if (name === 'HttpException') return statusOf(args[1]);
    const cls = resolveClass(this.ctx, nameNode);
    for (const c of cls ? lineage(this.ctx, cls) : []) {
      const ext = c.getExtends()?.getExpression().getText().split('.').pop();
      if (!ext) break;
      if (NEST_EXCEPTIONS[ext]) return NEST_EXCEPTIONS[ext];
      if (ext === 'HttpException') {
        for (const ctor of c.getConstructors()) {
          for (const sup of ctor.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (sup.getExpression().getKind() === SyntaxKind.SuperKeyword) {
              const status = statusOf(sup.getArguments()[1]);
              if (status) return status;
            }
          }
        }
        return undefined;
      }
    }
    // Not an HttpException: Nest's default handling turns it into a 500.
    return 500;
  }
}

// ---------------------------------------------------------------------------------------------

/** True for `a.b()` in `a.b().c()`: the outer call owns the chain. */
export function isInnerLink(call: CallExpression): boolean {
  let p: Node | undefined = call.getParent();
  while (p && Node.isNonNullExpression(p)) p = p.getParent();
  if (!p || !Node.isPropertyAccessExpression(p)) return false;
  const pp = p.getParent();
  return !!pp && Node.isCallExpression(pp) && pp.getExpression() === p;
}

/** Flattens `this.repo.createQueryBuilder('u').where(...).getOne()` into a root and named segments. */
export function chainOf(call: CallExpression): { root: Node; segs: Seg[] } {
  const segs: Seg[] = [];
  let e: Node = call.getExpression();
  let pendingCall: CallExpression | undefined = call;
  for (;;) {
    while (Node.isNonNullExpression(e) || Node.isParenthesizedExpression(e)) e = e.getExpression();
    if (Node.isPropertyAccessExpression(e)) {
      segs.unshift({ name: e.getName(), call: pendingCall });
      pendingCall = undefined;
      e = e.getExpression();
      continue;
    }
    if (Node.isCallExpression(e) && !pendingCall) {
      pendingCall = e;
      e = e.getExpression();
      continue;
    }
    break;
  }
  return { root: e, segs };
}

function isAwaited(call: CallExpression): boolean {
  let p: Node | undefined = call.getParent();
  while (p && (Node.isParenthesizedExpression(p) || Node.isNonNullExpression(p) || Node.isAsExpression(p))) p = p.getParent();
  return !!p && Node.isAwaitExpression(p);
}

function messageText(arg: Node): string {
  const n = unwrap(arg);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return trunc(n.getLiteralText(), 70);
  if (Node.isTemplateExpression(n)) return trunc(n.getText().slice(1, -1), 70);
  const message = objectProp(n, 'message');
  if (message) return messageText(message);
  return trunc(n.getText(), 70);
}

/** Column names used to look a row up: `{ where: { email } }` or `{ id }`. */
function whereKeys(arg: Node | undefined): string[] {
  if (!arg || !Node.isObjectLiteralExpression(arg)) return [];
  const where = objectProp(arg, 'where');
  const target = where ? unwrap(where) : arg;
  if (!Node.isObjectLiteralExpression(target)) return [];
  const keys: string[] = [];
  for (const p of target.getProperties()) {
    if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) keys.push(p.getName());
  }
  // Without `where`, an object made only of find options ({ order, take }) is not a criteria object.
  if (!where && keys.some((k) => FIND_OPTIONS.has(k))) return [];
  return keys;
}

const FIND_OPTIONS = new Set(['relations', 'order', 'select', 'skip', 'take', 'withDeleted', 'lock', 'cache', 'loadEagerRelations', 'transaction']);

function countSteps(steps: Step[]): number {
  let n = 0;
  for (const s of steps) {
    n++;
    if ('body' in s && s.body) n += countSteps(s.body);
    if (s.kind === 'if') n += countSteps(s.then) + countSteps(s.else ?? []);
    if (s.kind === 'switch') for (const c of s.cases) n += countSteps(c.body);
    if (s.kind === 'try') n += countSteps(s.catchBody ?? []) + countSteps(s.finallyBody ?? []);
  }
  return n;
}
