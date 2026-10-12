import { CallExpression, ClassDeclaration, Identifier, Node, Statement, SyntaxKind } from 'ts-morph';
import { NEST_EXCEPTIONS } from '../http';
import { Layer, Raise, Step } from '../model';
import {
  Callable,
  Ctx,
  Dep,
  classLayer,
  findCallable,
  getDeps,
  isFunctionNode,
  isPackageImport,
  lineage,
  literalList,
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

/** Route metadata by target, as Nest's Reflector sees it. `complete` is false when a decorator could not be read. */
export interface RouteMeta {
  handler: Map<string, string>;
  cls: Map<string, string>;
  complete: boolean;
}

/** Per-endpoint bookkeeping shared by every function walked for that endpoint. */
export interface Scope {
  warnings: Set<string>;
  expanded: Map<string, number>;
  /** Exceptions each expanded function lets escape, for later call sites drawn without a body. */
  raises: Map<string, Raise[]>;
  entityOps: Map<ClassDeclaration, Set<string>>;
}

export function newScope(): Scope {
  return { warnings: new Set(), expanded: new Map(), raises: new Map(), entityOps: new Map() };
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
  /** Class that declares the function being walked (for `super`). */
  cls?: ClassDeclaration;
  /** Class of the actual instance (for `this.x()`, which dispatches to overrides). */
  self?: ClassDeclaration;
  layer: Layer;
  depth: number;
  stack: string[];
  /** Names bound to the raw response object (`@Res() res`, middleware `res`). */
  res: Set<string>;
  /** Local variables known to hold a query builder, entity manager or query runner. */
  dbVars: Map<string, DbVar>;
  /** Steps that stand in for `super.canActivate()` in a Passport guard. */
  passport?: Step[];
  /** Metadata the endpoint sets (`@Public()` → isPublic), so guards that read it can be decided. */
  meta?: RouteMeta;
  /** Names bound to the incoming request (middleware `req`, `context.switchToHttp().getRequest()`). */
  reqNames: Set<string>;
  /** Local variables holding a reflector lookup, resolved against `meta`. */
  reflected: Map<string, boolean>;
  /** HTTP method of the route, so middleware checks such as `req.method === 'POST'` can be decided. */
  verb?: string;
  /** Full path template of the route (`/api/v1/users/:id`), for checks such as `req.path.startsWith(...)`. */
  route?: string;
  /** Parameters of a failure callback (`.catch(e => ...)`): rethrowing one passes the original error on. */
  failure?: Set<string>;
  /** Inside a loop body, where `if (x) continue;` matters even with nothing else in the branch. */
  inLoop?: boolean;
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
  entry(
    fn: Callable,
    cls: ClassDeclaration | undefined,
    layer: Layer,
    extra: { res?: string[]; passport?: Step[]; self?: ClassDeclaration; meta?: RouteMeta; verb?: string; route?: string; req?: string } = {},
  ): Step[] {
    const self = extra.self ?? cls;
    const key = `${self?.getName() ?? ''}.${Node.isMethodDeclaration(fn) ? fn.getName() : 'fn'}()`;
    return this.fn(fn, {
      cls,
      self,
      layer,
      depth: 0,
      stack: [key],
      res: new Set(extra.res ?? []),
      dbVars: new Map(),
      passport: extra.passport,
      meta: extra.meta,
      reflected: new Map(),
      reqNames: new Set(extra.req ? [extra.req] : []),
      verb: extra.verb,
      route: extra.route,
    });
  }

  private fn(fn: Callable, w: W): Step[] {
    const body = fn.getBody();
    if (!body) return [];
    if (Node.isBlock(body)) return this.stmts(body.getStatements(), w);
    return this.calls(body, w);
  }

  private child(w: W): W {
    return { ...w, dbVars: new Map(w.dbVars), reflected: new Map(w.reflected), reqNames: new Set(w.reqNames) };
  }

  private stmts(list: Statement[], w: W): Step[] {
    return list.flatMap((s) => this.stmt(s, w));
  }

  /**
   * Decides a condition that only depends on route metadata, e.g. `if (isPublic) return true;` in a
   * guard when the endpoint has `@Public()`. Undefined when it cannot be decided statically.
   */
  private decide(cond: Node, w: W): boolean | undefined {
    if (!w.meta && !w.verb && !w.route) return undefined;
    const u = unwrap(cond);
    if (Node.isPrefixUnaryExpression(u) && u.getOperatorToken() === SyntaxKind.ExclamationToken) {
      const v = this.decide(u.getOperand(), w);
      return v === undefined ? undefined : !v;
    }
    if (Node.isBinaryExpression(u)) {
      const op = u.getOperatorToken().getText();
      if (op === '&&' || op === '||') {
        const l = this.decide(u.getLeft(), w);
        const r = this.decide(u.getRight(), w);
        if (op === '&&') return l === false || r === false ? false : l === true && r === true ? true : undefined;
        return l === true || r === true ? true : l === false && r === false ? false : undefined;
      }
      // `req.path === '/healthcheck'`
      if (w.route && /^(===|==|!==|!=)$/.test(op)) {
        const [p, lit] = this.isReqProp(u.getLeft(), w, 'path') ? [u.getLeft(), u.getRight()] : [u.getRight(), u.getLeft()];
        const value = this.isReqProp(p, w, 'path') ? literalText(lit) : undefined;
        const same = value !== undefined ? pathEquals(w.route, value) : undefined;
        if (same !== undefined) return same === op.startsWith('=');
      }
      // `req.method === 'POST'`
      if (w.verb && w.verb !== 'ALL' && /^(===|==|!==|!=)$/.test(op)) {
        const [m, lit] = this.isReqProp(u.getLeft(), w, 'method') ? [u.getLeft(), u.getRight()] : [u.getRight(), u.getLeft()];
        const value = this.isReqProp(m, w, 'method') ? literalText(lit) : undefined;
        if (value !== undefined) return (value.toUpperCase() === w.verb) === op.startsWith('=');
      }
    }
    // `req.path.startsWith('/v1/webhook/')`, `req.originalUrl.startsWith(...)`
    if (w.route && Node.isCallExpression(u) && Node.isPropertyAccessExpression(u.getExpression())) {
      const callee = u.getExpression() as import('ts-morph').PropertyAccessExpression;
      const value = literalText(u.getArguments()[0]);
      const prop = ['path', 'url', 'originalUrl'].find((x) => this.isReqProp(callee.getExpression(), w, x));
      if (prop && value !== undefined && /^(startsWith|includes)$/.test(callee.getName())) {
        const v = pathPrefixCheck(w.route, value, callee.getName() as 'startsWith' | 'includes', prop !== 'path');
        if (v !== undefined) return v;
      }
    }
    // `['POST', 'PUT'].includes(req.method)`
    if (w.verb && w.verb !== 'ALL' && Node.isCallExpression(u) && /\.includes$/.test(u.getExpression().getText()) && u.getArguments()[0] && this.isReqProp(u.getArguments()[0], w, 'method')) {
      const list = (u.getExpression() as any).getExpression();
      const values = literalList(list);
      if (values.length) return values.map((v) => v.toUpperCase()).includes(w.verb);
    }
    if (!w.meta) return undefined;
    if (Node.isIdentifier(u) && w.reflected.has(u.getText())) return w.reflected.get(u.getText());
    if (Node.isCallExpression(u)) return this.reflectorLookup(u, w);
    return undefined;
  }

  /** `req.method` / `req.path` on the request object itself (not any object with such a property). */
  private isReqProp(n: Node, w: W, prop: string): boolean {
    const u = unwrap(n);
    return Node.isPropertyAccessExpression(u) && u.getName() === prop && Node.isIdentifier(u.getExpression()) && w.reqNames.has(u.getExpression().getText());
  }

  /**
   * `this.reflector.get(KEY, context.getHandler())` and friends: true when the targets read carry KEY
   * with a truthy value. `get` reads one target; getAllAndOverride takes the first that has it.
   */
  private reflectorLookup(call: Node, w: W): boolean | undefined {
    if (!w.meta || !Node.isCallExpression(call)) return undefined;
    const m = /reflector\.(get|getAllAndOverride|getAllAndMerge)$/i.exec(call.getExpression().getText());
    if (!m) return undefined;
    const key = literalText(call.getArguments()[0]);
    const targets = call.getArguments()[1]?.getText() ?? '';
    if (key === undefined) return undefined;
    const readsHandler = /getHandler\s*\(/.test(targets);
    const readsClass = /getClass\s*\(/.test(targets);
    if (!readsHandler && !readsClass) return undefined;
    const value = (readsHandler ? w.meta.handler.get(key) : undefined) ?? (readsClass ? w.meta.cls.get(key) : undefined);
    if (value === undefined) return w.meta.complete ? false : undefined;
    return !/^(false|0|null|undefined|''|"")$/.test(value);
  }

  private stmt(s: Node, w: W): Step[] {
    const layer = w.layer;
    const loc = locOf(this.ctx, s);

    if (Node.isBlock(s)) return this.stmts(s.getStatements(), w);

    if (Node.isIfStatement(s)) {
      const decided = this.decide(s.getExpression(), w);
      if (decided === true) return this.stmt(s.getThenStatement(), w);
      if (decided === false) {
        const elseNode = s.getElseStatement();
        return elseNode ? this.stmt(elseNode, w) : [];
      }
      const pre = this.calls(s.getExpression(), w, true);
      const then = this.stmt(s.getThenStatement(), w);
      const elseNode = s.getElseStatement();
      const els = elseNode ? this.stmt(elseNode, w) : [];
      if (!then.length && !els.length) return pre;
      if (!w.inLoop && then.every((t) => t.kind === 'jump') && els.every((t) => t.kind === 'jump')) return pre;
      return [...pre, { kind: 'if', layer, cond: trunc(s.getExpression().getText(), 70), then, else: els.length ? els : undefined, loc }];
    }

    if (Node.isSwitchStatement(s)) {
      const pre = this.calls(s.getExpression(), w, true);
      const clauses = s.getClauses();
      // A clause that does not end in break/return/throw/continue falls through into the next one.
      const own = clauses.map((c) => this.stmts(c.getStatements(), { ...w, inLoop: true }));
      const full: Step[][] = new Array(clauses.length);
      for (let i = clauses.length - 1; i >= 0; i--) {
        const stmts = clauses[i].getStatements();
        const falls = (stmts.length === 0 || !endsInJump(stmts)) && i + 1 < clauses.length;
        full[i] = falls ? [...own[i], ...full[i + 1]] : own[i];
      }
      const cases: { label: string; body: Step[] }[] = [];
      let pending: string[] = [];
      let hasDefault = false;
      clauses.forEach((clause, i) => {
        const label = Node.isCaseClause(clause) ? trunc(clause.getExpression().getText(), 30) : 'default';
        if (label === 'default') hasDefault = true;
        pending.push(label);
        if (!clause.getStatements().length && i + 1 < clauses.length) return; // stacked `case a: case b:`
        cases.push({ label: pending.join(' / '), body: full[i] });
        pending = [];
      });
      if (!cases.some((c) => c.body.some((b) => b.kind !== 'jump'))) return pre;
      return [...pre, { kind: 'switch', layer, subject: trunc(s.getExpression().getText(), 50), cases, hasDefault, loc }];
    }

    if (Node.isForOfStatement(s) || Node.isForInStatement(s)) {
      const pre = this.calls(s.getExpression(), w);
      const body = this.stmt(s.getStatement(), { ...w, inLoop: true });
      if (!body.some((b) => b.kind !== 'jump')) return pre;
      const item = oneLine(s.getInitializer().getText()).replace(/^(const|let|var)\s+/, '');
      const word = Node.isForOfStatement(s) ? 'of' : 'in';
      return [...pre, { kind: 'loop', layer, label: trunc(`for each ${item} ${word} ${s.getExpression().getText()}`, 60), body, loc }];
    }

    if (Node.isForStatement(s) || Node.isWhileStatement(s) || Node.isDoStatement(s)) {
      const cond = Node.isForStatement(s) ? s.getCondition() : s.getExpression();
      const pre = this.calls(cond, w, true);
      const body = this.stmt(s.getStatement(), { ...w, inLoop: true });
      if (!body.some((b) => b.kind !== 'jump')) return pre;
      return [...pre, { kind: 'loop', layer, label: trunc(`loop while ${cond?.getText() ?? 'true'}`, 60), body, loc }];
    }

    if (Node.isTryStatement(s)) {
      let body = this.stmts(s.getTryBlock().getStatements(), w);
      const clause = s.getCatchClause();
      const catchBody = clause ? this.stmts(clause.getBlock().getStatements(), w) : undefined;
      const fin = s.getFinallyBlock();
      const finallyBody = fin ? this.stmts(fin.getStatements(), w) : [];
      if (!body.length) {
        // `try { data = JSON.parse(raw) } catch { throw ... }`: nothing worth drawing, but it can still throw.
        const first = s.getTryBlock().getStatements()[0];
        if (!catchBody?.length || !first) return finallyBody;
        body = [{ kind: 'action', layer, label: trunc(first.getText().replace(/;$/, ''), 50), loc: locOf(this.ctx, first) }];
      }
      const v = clause?.getVariableDeclaration()?.getName();
      const swallowed = clause && !catchBody?.length;
      return [
        {
          kind: 'try',
          layer,
          body,
          catchLabel: clause ? `catch ${v ?? 'error'}${swallowed ? ' (handled, flow continues)' : ''}` : undefined,
          catchVar: v,
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
        const info = describeException(this.ctx, e.getExpression(), e.getArguments());
        return [...pre, { kind: 'throw', layer, exception: e.getExpression().getText(), ...info, loc }];
      }
      // `throw err || new UnauthorizedException()`: the fallback is what a missing error turns into.
      if (Node.isBinaryExpression(e) && /^(\|\||\?\?)$/.test(e.getOperatorToken().getText()) && Node.isNewExpression(unwrap(e.getRight()))) {
        const made = unwrap(e.getRight()) as import('ts-morph').NewExpression;
        const info = describeException(this.ctx, made.getExpression(), made.getArguments());
        return [...pre, { kind: 'throw', layer, exception: made.getExpression().getText(), ...info, loc }];
      }
      if (Node.isConditionalExpression(e) && Node.isNewExpression(unwrap(e.getWhenTrue())) && Node.isNewExpression(unwrap(e.getWhenFalse()))) {
        const side = (n: Node): Step => {
          const made = unwrap(n) as import('ts-morph').NewExpression;
          return { kind: 'throw', layer, exception: made.getExpression().getText(), ...describeException(this.ctx, made.getExpression(), made.getArguments()), loc };
        };
        return [...pre, { kind: 'if', layer, cond: trunc(e.getCondition().getText(), 70), then: [side(e.getWhenTrue())], else: [side(e.getWhenFalse())], loc }];
      }
      // `throw this.invalid(...)`: a helper that builds the exception.
      const built = Node.isCallExpression(e) ? this.builtException(e, w) : undefined;
      if (built) {
        const info = describeException(this.ctx, built.getExpression(), built.getArguments());
        return [...pre.filter((p) => !(p.kind === 'call' && !p.body)), { kind: 'throw', layer, exception: built.getExpression().getText(), ...info, loc }];
      }
      const rethrow = Node.isIdentifier(e) ? e.getText() : undefined;
      if (rethrow && w.failure?.has(rethrow)) return [...pre, { kind: 'throw', layer, exception: `rethrow ${rethrow}`, rethrow, passThrough: true, loc }];
      return [...pre, { kind: 'throw', layer, exception: `rethrow ${trunc(e.getText(), 30)}`, rethrow, loc }];
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
        if (w.meta && Node.isIdentifier(d.getNameNode())) {
          const lookup = this.reflectorLookup(u, w);
          if (lookup !== undefined) w.reflected.set(d.getName(), lookup);
        }
        if (Node.isIdentifier(d.getNameNode()) && /\.getRequest\s*(<[^>]*>)?\s*\(\s*\)$/.test(u.getText())) w.reqNames.add(d.getName());
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

    if (Node.isBreakStatement(s) || Node.isContinueStatement(s)) {
      return [{ kind: 'jump', layer, jump: Node.isBreakStatement(s) ? 'break' : 'continue', loc }];
    }
    if (Node.isFunctionDeclaration(s) || Node.isClassDeclaration(s)) return [];
    if (Node.isLabeledStatement(s)) return this.stmt(s.getStatement(), w);
    return this.calls(s, w);
  }

  private other(s: Node, w: W): Step[] {
    if (!this.ctx.opts.verbose) return [];
    return [{ kind: 'action', layer: w.layer, label: trunc(s.getText().replace(/;$/, ''), 60), loc: locOf(this.ctx, s) }];
  }

  // -------------------------------------------------------------------------------------------
  // Calls

  /**
   * Every call in an expression that is worth drawing, in evaluation order. `a ? b : c`, `a && b`,
   * `a || b` and `a ?? b` become branches, so a call that only runs on one side is not drawn as if
   * it always ran.
   */
  private calls(node: Node | undefined, w: W, condition = false): Step[] {
    if (!node) return [];
    if (isFunctionNode(node) || Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node) || Node.isClassExpression(node)) return [];
    const loc = () => locOf(this.ctx, node);

    if (Node.isConditionalExpression(node)) {
      const pre = this.calls(node.getCondition(), w, true);
      const yes = this.calls(node.getWhenTrue(), w, condition);
      const no = this.calls(node.getWhenFalse(), w, condition);
      if (!yes.length && !no.length) return pre;
      return [...pre, { kind: 'if', layer: w.layer, cond: trunc(node.getCondition().getText(), 70), then: yes, else: no.length ? no : undefined, loc: loc() }];
    }
    if (Node.isBinaryExpression(node)) {
      const op = node.getOperatorToken().getText();
      if (op === '&&' || op === '||' || op === '??') {
        const left = this.calls(node.getLeft(), w, true);
        const right = this.calls(node.getRight(), w, condition);
        if (!right.length) return left;
        const text = trunc(node.getLeft().getText(), 60);
        const branch: Step =
          op === '&&'
            ? { kind: 'if', layer: w.layer, cond: text, then: right, loc: loc() }
            : op === '||'
              ? { kind: 'if', layer: w.layer, cond: text, then: [], else: right, loc: loc() }
              : { kind: 'if', layer: w.layer, cond: `${text} is null or undefined`, then: right, loc: loc() };
        return [...left, branch];
      }
    }

    const out: Step[] = [];
    if (Node.isCallExpression(node) && !isInnerLink(node)) {
      // `source.pipe(catchError(...), map(...))`: the operators' callbacks run after the source call.
      const operators = isPipe(node) ? node.getArguments().filter((a) => Node.isCallExpression(unwrap(a))) : [];
      node.forEachChild((c) => {
        if (!operators.includes(c)) out.push(...this.calls(c, w, condition));
      });
      const r = this.classify(node, w);
      // `await firstValueFrom(this.http.post(...))`: the wrapper adds nothing once the inner call is drawn,
      // and in a condition the decision node already shows the call.
      const wrapper = Node.isIdentifier(node.getExpression());
      if (!(r.fallback && ((out.length && wrapper) || condition))) out.push(...r.steps);
      if (!r.handled) out.push(...this.callbacks(node, w));
      const source = Node.isPropertyAccessExpression(node.getExpression()) ? (node.getExpression() as any).getExpression().getText() : '';
      for (const op of operators) out.push(...this.callbacks(unwrap(op) as CallExpression, w, source));
      return out;
    }
    node.forEachChild((c) => {
      out.push(...this.calls(c, w, condition));
    });
    return out;
  }

  /**
   * Function arguments: iterator callbacks are loops, `.catch(fn)` / `.then(_, fn)` / `catchError(fn)`
   * run only when the call fails, anything else is drawn inline after the call.
   */
  private callbacks(call: CallExpression, w: W, source?: string): Step[] {
    const out: Step[] = [];
    const callee = call.getExpression();
    // CSRF middleware (csurf, csrf-csrf) skips GET, HEAD and OPTIONS by default, so its error callback cannot fire there.
    if (w.verb && /^(GET|HEAD|OPTIONS)$/.test(w.verb) && /csrf/i.test(callee.getText()) && !/ignored?Methods/.test(this.csrfConfig())) return out;
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : Node.isIdentifier(callee) ? callee.getText() : '';
    const target = source ?? (Node.isPropertyAccessExpression(callee) ? callee.getExpression().getText() : '');
    call.getArguments().forEach((arg, i) => {
      if (!isFunctionNode(arg)) return;
      const onFailure = name === 'catch' || name === 'catchError' || (name === 'then' && i === 1);
      const inner = this.child(w);
      const param = arg.getParameters()[0]?.getName();
      if (onFailure && param) inner.failure = new Set([...(w.failure ?? []), param]);
      const body = this.fn(arg, inner);
      if (!body.length) return;
      const loc = locOf(this.ctx, call);
      if (Node.isPropertyAccessExpression(callee) && ITERATORS.has(name)) {
        out.push({ kind: 'loop', layer: w.layer, label: `for each item of ${trunc(callee.getExpression().getText(), 30)}`, body, callback: true, loc });
      } else if (onFailure) {
        out.push({ kind: 'if', layer: w.layer, cond: `${trunc(target || 'the call', 50)} fails`, then: body, loc });
      } else {
        out.push({ kind: 'group', layer: w.layer, label: `${trunc(callee.getText(), 40)}(…) callback`, body, loc });
      }
    });
    return out;
  }

  private csrfText?: string;
  /** Source of the CSRF setup calls (`doubleCsrf({...})`, `csurf({...})`), to see whether ignored methods are configured. */
  private csrfConfig(): string {
    if (this.csrfText !== undefined) return this.csrfText;
    const parts: string[] = [];
    for (const sf of this.ctx.files) {
      if (!/csrf/i.test(sf.getFullText())) continue;
      for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) if (/^(doubleCsrf|csurf|csrf)$/.test(c.getExpression().getText())) parts.push(c.getText());
    }
    return (this.csrfText = parts.join('\n'));
  }

  /** The `new X(...)` a helper returns, for `throw this.invalid()`. */
  private builtException(call: CallExpression, w: W): import('ts-morph').NewExpression | undefined {
    const { root, segs } = chainOf(call);
    let fn: Callable | undefined;
    const self = w.self ?? w.cls;
    if (Node.isThisExpression(root) && self && segs.length === 1) fn = findCallable(this.ctx, self, segs[0].name)?.fn;
    else if (Node.isIdentifier(root) && !segs.length) {
      const decl = resolveIdentifier(this.ctx, root);
      if (decl && Node.isFunctionDeclaration(decl)) fn = decl;
      else if (decl && Node.isVariableDeclaration(decl) && isFunctionNode(decl.getInitializer())) fn = decl.getInitializer() as Callable;
    }
    const body = fn?.getBody();
    if (!body) return undefined;
    const returned = Node.isBlock(body) ? body.getDescendantsOfKind(SyntaxKind.ReturnStatement).map((r) => r.getExpression()) : [body];
    for (const r of returned) {
      const u = r ? unwrap(r) : undefined;
      if (u && Node.isNewExpression(u)) return u;
    }
    return undefined;
  }

  private classify(call: CallExpression, w: W): Classified {
    const { root, segs } = chainOf(call);
    const loc = locOf(this.ctx, call);

    // Raw response object: res.status(401).json(...)
    if (Node.isIdentifier(root) && w.res.has(root.getText())) {
      const sender = segs.find((s) => RESPONSE_SENDERS.has(s.name));
      if (!sender) {
        // `res.status(428); return body;` (passthrough): the status applies to whatever is sent next.
        const statusSeg = segs.find((s) => s.name === 'status' && s.call);
        const status = statusOf(statusSeg?.call?.getArguments()[0]);
        if (status === undefined) return { steps: [] };
        return { steps: [{ kind: 'respond', layer: w.layer, status, label: `status(${status}), then the handler's result is sent`, loc }] };
      }
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
      return { steps: this.expand(target.owner, target.fn, `${target.owner.getName()}.${first.name}()`, w.layer, w, call, true, w.self) };
    }

    if (Node.isThisExpression(root) && w.cls) {
      const first = segs[0];
      const self = w.self ?? w.cls;
      if (!first) return { steps: [] };
      if (first.call) {
        // `this.validate()` inside an inherited method runs the subclass's override.
        const target = findCallable(this.ctx, self, first.name);
        if (!target) return { steps: [] };
        return { steps: this.expand(target.owner, target.fn, `${self.getName()}.${first.name}()`, w.layer, w, call, true, self) };
      }
      const dep = getDeps(this.ctx, self).get(first.name);
      const rest = segs.slice(1);
      // A property the tool does not recognise: fall through, so an awaited call through it is still drawn.
      if (dep && rest.length) return { steps: this.depCall(dep, rest, call, w) };
      if (!rest.length) return { steps: [] };
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
          return { steps: this.expand(undefined, decl, `${name}()`, w.layer, w, call, true, undefined) };
        }
        if (Node.isVariableDeclaration(decl) && isFunctionNode(decl.getInitializer())) {
          return { steps: this.expand(undefined, decl.getInitializer() as Callable, `${name}()`, w.layer, w, call, true, undefined) };
        }
      }
      if (segs.length === 1 && segs[0].call && decl && Node.isClassDeclaration(decl)) {
        const m = decl.getStaticMethod(segs[0].name);
        if (m?.getBody()) {
          return { steps: this.expand(decl, m, `${name}.${segs[0].name}()`, classLayer(this.ctx, decl), w, call, true, decl) };
        }
      }
    }

    // `return this.s3Client.send(cmd)` in an async function: a client typed from a package is I/O even unawaited.
    if (isReturned(call) && Node.isThisExpression(root) && segs.length > 1 && !segs[0].call && w.self && packageTyped(w.self, segs[0].name)) {
      return { steps: [{ kind: 'external', layer: 'external', label: `${trunc(call.getExpression().getText(), 44)}()`, loc }], fallback: true };
    }
    // Anything else: keep awaited calls (they usually do I/O), drop synchronous helpers.
    if (isAwaited(call) || this.ctx.opts.verbose) {
      const text = call.getExpression().getText();
      if (/^(this\.)?(logger|log)\b/i.test(text)) return { steps: [] };
      // Awaiting a package function or a client held in a property (`this.s3Client.send()`) is I/O outside the project.
      const outside = isAwaited(call) && ((Node.isIdentifier(root) && isPackageImport(root)) || (Node.isThisExpression(root) && segs.length > 1 && !segs[0].call));
      if (outside) return { steps: [{ kind: 'external', layer: 'external', label: `${trunc(text, 44)}()`, loc }], fallback: true };
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
        if (target) return this.expand(target.owner, target.fn, label, layer, w, call, false, dep.cls);
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
  private expand(
    owner: ClassDeclaration | undefined,
    fn: Callable,
    label: string,
    layer: Layer,
    w: W,
    at: Node,
    dropIfEmpty: boolean,
    self: ClassDeclaration | undefined,
  ): Step[] {
    const loc = locOf(this.ctx, at);
    if (w.stack.includes(label)) return [{ kind: 'call', layer, label, note: 'recursive call', loc }];
    if (w.depth >= this.ctx.opts.depth) {
      this.scope.warnings.add(`Stopped following calls at \`${label}\` (depth limit ${this.ctx.opts.depth}; raise it with --depth).`);
      return [{ kind: 'call', layer, label, note: 'not expanded: depth limit', loc }];
    }
    const body = this.fn(fn, {
      cls: owner,
      self: self ?? owner,
      layer,
      depth: w.depth + 1,
      stack: [...w.stack, label],
      res: new Set(),
      dbVars: new Map(),
      meta: w.meta,
      reflected: new Map(),
      reqNames: new Set(),
      verb: w.verb,
      route: w.route,
    });
    if (dropIfEmpty && body.every((b) => b.kind === 'return')) return [];
    const seen = this.scope.expanded.get(label) ?? 0;
    this.scope.expanded.set(label, seen + 1);
    if (seen === 0) this.scope.raises.set(label, escaping(body));
    if (seen > 0 && countSteps(body) > 3) {
      const raises = this.scope.raises.get(label) ?? escaping(body);
      return [{ kind: 'call', layer, label, note: 'expanded earlier in this diagram', ...(raises.length && { raises }), loc }];
    }
    return [{ kind: 'call', layer, label, body, loc }];
  }

  // -------------------------------------------------------------------------------------------
  // Database access

  /** Recognises a call chain rooted at a repository, entity manager, data source or query builder. */
  private dbChain(call: CallExpression, w: W): { entity?: ClassDeclaration; qb?: boolean; segs: Seg[] } | undefined {
    const { root, segs } = chainOf(call);
    if (Node.isThisExpression(root) && w.cls && segs.length > 1 && !segs[0].call) {
      const dep = getDeps(this.ctx, w.self ?? w.cls).get(segs[0].name);
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
            body: this.fn(h.method, { cls: h.owner, layer: 'entity', depth: w.depth + 1, stack: w.stack, res: new Set(), dbVars: new Map(), reflected: new Map(), reqNames: new Set() }),
            loc: locOf(this.ctx, h.method),
          }));
      steps.push(...wanted.before.flatMap(hookStep), dbNode, ...wanted.after.flatMap(hookStep));
    } else {
      steps.push(dbNode);
    }
    return { steps };
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

function isReturned(call: CallExpression): boolean {
  let p: Node | undefined = call.getParent();
  while (p && (Node.isParenthesizedExpression(p) || Node.isNonNullExpression(p) || Node.isAsExpression(p))) p = p.getParent();
  return !!p && (Node.isReturnStatement(p) || (Node.isArrowFunction(p) && p.getBody() === call));
}

/** A property whose declared type comes from a package (`private s3Client: S3Client`). */
function packageTyped(cls: ClassDeclaration, name: string): boolean {
  for (let c: ClassDeclaration | undefined = cls; c; ) {
    const prop = c.getInstanceProperty(name);
    const typeNode = prop && Node.isPropertyDeclaration(prop) ? prop.getTypeNode() : c.getConstructors()[0]?.getParameter(name)?.getTypeNode();
    if (typeNode && Node.isTypeReference(typeNode)) {
      const id = typeNode.getTypeName();
      return Node.isIdentifier(id) && isPackageImport(id);
    }
    const ext = c.getExtends()?.getExpression();
    const sym = ext && Node.isIdentifier(ext) ? ext.getSymbol() : undefined;
    const decl = sym?.getDeclarations().find((d) => Node.isClassDeclaration(d)) as ClassDeclaration | undefined;
    c = decl && decl !== c ? decl : undefined;
  }
  return false;
}

function isAwaited(call: CallExpression): boolean {
  let p: Node | undefined = call.getParent();
  while (p && (Node.isParenthesizedExpression(p) || Node.isNonNullExpression(p) || Node.isAsExpression(p))) p = p.getParent();
  return !!p && Node.isAwaitExpression(p);
}

// ---------------------------------------------------------------------------------------------
// Exceptions

/** A node and the constructor parameters it may refer to (`super(message, status)` inside a subclass). */
interface Val {
  node: Node | undefined;
  env: Map<string, Val>;
}

function resolveVal(v: Val): Val {
  let cur = v;
  for (let i = 0; i < 20; i++) {
    const n = cur.node ? unwrap(cur.node) : undefined;
    if (!n) return cur;
    // `msg.key` where msg is the caller's `{ key: '...' }`
    if (Node.isPropertyAccessExpression(n) && Node.isIdentifier(n.getExpression()) && cur.env.has(n.getExpression().getText())) {
      const obj = resolveVal(cur.env.get(n.getExpression().getText())!);
      const prop = obj.node ? objectProp(obj.node, n.getName()) : undefined;
      if (!prop) return cur;
      cur = { node: prop, env: obj.env };
      continue;
    }
    if (!Node.isIdentifier(n)) return cur;
    const next = cur.env.get(n.getText());
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/** What is known about a value's shape: `typeof` and own keys of an object literal. */
function shapeOf(v: Val): { type?: string; keys?: string[] } {
  const r = resolveVal(v);
  const n = r.node ? unwrap(r.node) : undefined;
  if (!n) return { type: 'undefined' };
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n) || Node.isTemplateExpression(n)) return { type: 'string' };
  if (Node.isNumericLiteral(n)) return { type: 'number' };
  if (Node.isObjectLiteralExpression(n)) {
    return { type: 'object', keys: n.getProperties().map((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : '')).filter(Boolean) };
  }
  return {};
}

/** Evaluates `typeof msg === 'object'`, `'key' in msg`, `!`, `&&`, `||` against the caller's arguments. */
function evalShape(cond: Node, env: Map<string, Val>): boolean | undefined {
  const u = unwrap(cond);
  if (Node.isPrefixUnaryExpression(u) && u.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const v = evalShape(u.getOperand(), env);
    return v === undefined ? undefined : !v;
  }
  if (!Node.isBinaryExpression(u)) return undefined;
  const op = u.getOperatorToken().getText();
  if (op === '&&' || op === '||') {
    const l = evalShape(u.getLeft(), env);
    const r = evalShape(u.getRight(), env);
    if (op === '&&') return l === false || r === false ? false : l && r ? true : undefined;
    return l === true || r === true ? true : l === false && r === false ? false : undefined;
  }
  const val = (n: Node) => (Node.isIdentifier(n) && env.has(n.getText()) ? env.get(n.getText())! : undefined);
  if (op === 'in') {
    const key = literalText(u.getLeft());
    const target = val(unwrap(u.getRight()));
    const shape = target ? shapeOf(target) : {};
    if (key === undefined || !shape.type) return undefined;
    return shape.type === 'object' && !!shape.keys?.includes(key);
  }
  if (/^(===|==|!==|!=)$/.test(op)) {
    const [t, lit] = Node.isTypeOfExpression(unwrap(u.getLeft())) ? [unwrap(u.getLeft()), u.getRight()] : [unwrap(u.getRight()), u.getLeft()];
    if (!Node.isTypeOfExpression(t)) return undefined;
    const target = val(unwrap(t.getExpression()));
    const want = literalText(lit);
    const shape = target ? shapeOf(target) : {};
    if (!shape.type || want === undefined) return undefined;
    return (shape.type === want) === op.startsWith('=');
  }
  return undefined;
}

/** The `super(...)` call a constructor makes for these arguments, ruling out branches the arguments contradict. */
function superCallFor(ctor: import('ts-morph').ConstructorDeclaration, env: Map<string, Val>): CallExpression | undefined {
  const supers = ctor.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => c.getExpression().getKind() === SyntaxKind.SuperKeyword);
  const possible = supers.filter((sup) => {
    let child: Node = sup;
    for (let p = sup.getParent(); p && p !== ctor; child = p, p = p.getParent()) {
      if (Node.isIfStatement(p)) {
        const v = evalShape(p.getExpression(), env);
        if (v !== undefined && v !== (p.getThenStatement() === child)) return false;
      }
    }
    return true;
  });
  // Undecided (the caller passes a variable): prefer the branch that hands the argument on unchanged.
  const passThrough = possible.find((sup) => {
    const first = sup.getArguments()[0];
    return !!first && Node.isIdentifier(unwrap(first)) && env.has(unwrap(first).getText());
  });
  return (possible.length > 1 ? passThrough : undefined) ?? possible[0] ?? supers[0];
}

function statusOfVal(v: Val): number | undefined {
  const r = resolveVal(v);
  return r.node ? statusOf(r.node) : undefined;
}

function messageOfVal(v: Val): string | undefined {
  const r = resolveVal(v);
  const n = r.node ? unwrap(r.node) : undefined;
  if (!n) return undefined;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return trunc(n.getLiteralText(), 70);
  if (Node.isTemplateExpression(n)) return trunc(n.getText().slice(1, -1), 70);
  if (Node.isObjectLiteralExpression(n)) {
    for (const key of ['message', 'error', 'detail', 'errors']) {
      const prop = objectProp(n, key);
      if (prop) return key === 'errors' ? trunc(prop.getText(), 70) : messageOfVal({ node: prop, env: r.env });
    }
    return trunc(n.getText(), 70);
  }
  if (Node.isIdentifier(n) && r.env.size) return literalText(n);
  return literalText(n) ?? trunc(n.getText(), 70);
}

/**
 * Status and message of `new X(...args)`. Project exception classes are followed through each
 * constructor's `super(...)` call, mapping parameters to the caller's arguments, until a Nest built-in
 * or HttpException is reached. A class imported from a package is never confused with a project class
 * of the same name.
 */
export function describeException(ctx: Ctx, nameNode: Node, args: Node[]): { status?: number; message?: string } {
  let vals: Val[] = args.map((node) => ({ node, env: new Map() }));
  let name = nameNode.getText().split('.').pop() ?? '';
  let cls = resolveClass(ctx, Node.isPropertyAccessExpression(nameNode) ? nameNode.getNameNode() : nameNode);
  for (let i = 0; i < 12 && cls; i++) {
    const ctor = cls.getConstructors().find((c) => c.getBody());
    if (ctor) {
      const env = new Map<string, Val>();
      const rest = new Map<string, Val[]>();
      ctor.getParameters().forEach((p, idx) => {
        if (p.isRestParameter()) {
          rest.set(p.getName(), vals.slice(idx));
          return;
        }
        const given = vals[idx];
        env.set(p.getName(), given?.node ? given : { node: p.getInitializer(), env: new Map() });
      });
      const sup = superCallFor(ctor, env);
      // `super(...args)` with a rest parameter passes the caller's arguments on as they are.
      vals = (sup?.getArguments() ?? []).flatMap((node): Val[] => {
        if (Node.isSpreadElement(node) && rest.has(node.getExpression().getText())) return rest.get(node.getExpression().getText())!;
        return [{ node, env }];
      });
    }
    const ext = cls.getExtends()?.getExpression();
    if (!ext) return { status: 500, message: vals[0] ? messageOfVal(vals[0]) : undefined };
    name = ext.getText().split('.').pop() ?? '';
    const base = resolveClass(ctx, Node.isPropertyAccessExpression(ext) ? ext.getNameNode() : ext);
    if (!base || base === cls) break;
    cls = base;
  }
  const message = vals[0] ? messageOfVal(vals[0]) : undefined;
  if (NEST_EXCEPTIONS[name]) return { status: NEST_EXCEPTIONS[name], message };
  if (name === 'HttpException') return { status: vals[1] ? statusOfVal(vals[1]) : undefined, message };
  // Not an HttpException: Nest's default handling turns plain errors into a 500.
  if (/Error$/.test(name)) return { status: 500, message };
  return { message };
}

/** Exceptions a function body lets escape (not swallowed by its own try/catch). */
function escaping(steps: Step[]): Raise[] {
  const out: Raise[] = [];
  const visit = (list: Step[]) => {
    for (const s of list) {
      if (s.kind === 'throw' && !s.rethrow) out.push({ exception: s.exception, status: s.status, message: s.message, loc: s.loc });
      else if (s.kind === 'call') {
        if (s.body) visit(s.body);
        else if (s.raises) out.push(...s.raises);
      } else if (s.kind === 'group' || s.kind === 'loop') visit(s.body);
      else if (s.kind === 'if') visit([...s.then, ...(s.else ?? [])]);
      else if (s.kind === 'switch') for (const c of s.cases) visit(c.body);
      else if (s.kind === 'try') {
        if (s.catchBody === undefined) visit(s.body);
        else if (s.catchVar && rethrows(s.catchBody, s.catchVar)) visit([...s.body, ...s.catchBody]);
        else visit(s.catchBody);
        visit(s.finallyBody ?? []);
      }
    }
  };
  visit(steps);
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.status}|${r.exception}|${r.message}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** `req.path === value` for a route template: decided when the template has no parameters or cannot match. */
function pathEquals(route: string, value: string): boolean | undefined {
  const norm = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
  if (/[*{(]/.test(route)) return undefined;
  if (!route.includes(':')) return norm(route) === norm(value);
  const re = new RegExp('^' + norm(route).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$');
  return re.test(norm(value)) ? undefined : false;
}

/** `req.path.startsWith(value)` / `.includes(value)`, judged on the template's fixed part before any parameter. */
function pathPrefixCheck(route: string, value: string, kind: 'startsWith' | 'includes', withQuery: boolean): boolean | undefined {
  // The template's fixed part ends at the first parameter or wildcard; a URL may also carry a query string.
  const cut = route.search(/[:*{(]/);
  const fixed = cut < 0 ? route : route.slice(0, cut);
  const open = cut >= 0 || withQuery;
  if (kind === 'startsWith') {
    if (fixed.startsWith(value)) return true;
    if (open && value.startsWith(fixed)) return undefined;
    return false;
  }
  if (fixed.includes(value)) return true;
  return open ? undefined : false;
}

/** Whether a catch block rethrows its error anywhere (`if (e instanceof X) throw e`). */
function rethrows(steps: Step[], v: string): boolean {
  return steps.some(
    (s) =>
      (s.kind === 'throw' && s.rethrow === v) ||
      (s.kind === 'if' && rethrows([...s.then, ...(s.else ?? [])], v)) ||
      (s.kind === 'switch' && s.cases.some((c) => rethrows(c.body, v))) ||
      ((s.kind === 'group' || s.kind === 'loop') && rethrows(s.body, v)) ||
      (s.kind === 'try' && rethrows([...s.body, ...(s.catchBody ?? []), ...(s.finallyBody ?? [])], v)),
  );
}

function isPipe(call: CallExpression): boolean {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getName() === 'pipe';
}

/** `continue` / `break` as the last statement of a branch. */
function jumpOf(s: Node): 'continue' | 'break' | undefined {
  const last = Node.isBlock(s) ? s.getStatements().at(-1) : s;
  if (!last) return undefined;
  if (Node.isContinueStatement(last)) return 'continue';
  if (Node.isBreakStatement(last)) return 'break';
  return undefined;
}

/** True when a switch clause cannot fall through into the next one. */
function endsInJump(stmts: Node[]): boolean {
  const last = stmts.at(-1);
  if (!last) return false;
  if (Node.isBlock(last)) return endsInJump(last.getStatements());
  if (Node.isIfStatement(last)) {
    const els = last.getElseStatement();
    return !!els && endsInJump([last.getThenStatement()]) && endsInJump([els]);
  }
  return Node.isBreakStatement(last) || Node.isReturnStatement(last) || Node.isThrowStatement(last) || Node.isContinueStatement(last);
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
