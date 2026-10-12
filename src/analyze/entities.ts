import { ClassDeclaration, MethodDeclaration, Node } from 'ts-morph';
import { EntityDoc } from '../model';
import { Ctx, decoratorArgs, lineage, literalText, locOf, objectProp, oneLine, trunc, unwrap } from '../project';

const COLUMN_DECORATORS = [
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'ObjectIdColumn',
  'Generated',
];
const RELATION_DECORATORS = ['OneToOne', 'OneToMany', 'ManyToOne', 'ManyToMany'];
const HOOK_DECORATORS = [
  'BeforeInsert',
  'AfterInsert',
  'BeforeUpdate',
  'AfterUpdate',
  'BeforeRemove',
  'AfterRemove',
  'BeforeSoftRemove',
  'AfterSoftRemove',
  'BeforeRecover',
  'AfterRecover',
  'AfterLoad',
];

export function isEntity(cls: ClassDeclaration | undefined): cls is ClassDeclaration {
  return !!cls && !!(cls.getDecorator('Entity') ?? cls.getDecorator('ViewEntity') ?? cls.getDecorator('ChildEntity'));
}

export interface Hook {
  event: string;
  method: MethodDeclaration;
  owner: ClassDeclaration;
}

export function entityHooks(ctx: Ctx, cls: ClassDeclaration): Hook[] {
  const hooks: Hook[] = [];
  for (const c of lineage(ctx, cls)) {
    for (const m of c.getInstanceMethods()) {
      for (const d of m.getDecorators()) {
        if (HOOK_DECORATORS.includes(d.getName())) hooks.push({ event: d.getName(), method: m, owner: c });
      }
    }
  }
  return hooks;
}

/**
 * Which entity listeners TypeORM runs for a repository / manager operation.
 * Only the operations that work on entity instances are mapped; query-builder style writes
 * (insert, update, delete, increment, ...) are left out on purpose.
 */
export function hooksForOp(op: string): { before: string[]; after: string[] } {
  if (op === 'save') return { before: ['BeforeInsert', 'BeforeUpdate'], after: ['AfterInsert', 'AfterUpdate'] };
  if (op === 'remove') return { before: ['BeforeRemove'], after: ['AfterRemove'] };
  if (op === 'softRemove') return { before: ['BeforeSoftRemove'], after: ['AfterSoftRemove'] };
  if (op === 'recover') return { before: ['BeforeRecover'], after: ['AfterRecover'] };
  if (/^(find|findOne|findBy|findOneBy|findOneOrFail|findOneByOrFail|findAndCount|findAndCountBy|getOne|getMany|getOneOrFail|getManyAndCount)$/.test(op)) {
    return { before: [], after: ['AfterLoad'] };
  }
  return { before: [], after: [] };
}

export function describeEntity(ctx: Ctx, cls: ClassDeclaration, ops: Iterable<string>): EntityDoc {
  const entityDec = cls.getDecorator('Entity') ?? cls.getDecorator('ViewEntity');
  const arg = decoratorArgs(entityDec)[0];
  const table = literalText(arg) ?? literalText(objectProp(arg, 'name'));
  const doc: EntityDoc = {
    name: cls.getName() ?? '(anonymous)',
    table,
    loc: locOf(ctx, cls),
    columns: [],
    relations: [],
    hooks: entityHooks(ctx, cls).map((h) => ({ event: h.event, method: `${h.method.getName()}()` })),
    subscribers: [],
    ops: [...new Set(ops)].sort(),
  };

  const classUnique = cls
    .getDecorators()
    .filter((d) => d.getName() === 'Unique' || d.getName() === 'Index')
    .map((d) => `@${d.getName()}(${trunc(d.getArguments().map((a) => a.getText()).join(', '), 50)})`);

  for (const c of lineage(ctx, cls).reverse()) {
    for (const p of c.getInstanceProperties()) {
      if (!Node.isPropertyDeclaration(p)) continue;
      const decs = p.getDecorators();
      const rel = decs.find((d) => RELATION_DECORATORS.includes(d.getName()));
      if (rel) {
        const target = rel.getArguments()[0];
        const targetText = target && Node.isArrowFunction(target) ? target.getBody().getText() : target?.getText() ?? '?';
        doc.relations.push({ name: p.getName(), kind: rel.getName(), target: trunc(targetText, 40) });
        continue;
      }
      const col = decs.find((d) => COLUMN_DECORATORS.includes(d.getName()));
      if (!col) continue;
      const args = col.getArguments();
      const options = args.find((a) => Node.isObjectLiteralExpression(unwrap(a)));
      const constraints: string[] = [];
      if (/^Primary/.test(col.getName())) constraints.push('primary key');
      if (col.getName() === 'PrimaryGeneratedColumn') constraints.push(`generated ${literalText(args[0]) ?? 'increment'}`);
      if (col.getName() !== 'Column' && !/^Primary/.test(col.getName())) constraints.push(col.getName());
      for (const key of ['unique', 'nullable', 'length', 'default', 'select', 'precision', 'scale', 'enum']) {
        const v = objectProp(options, key);
        if (!v) continue;
        const text = oneLine(v.getText());
        if (key === 'unique' || key === 'nullable') {
          if (text === 'true') constraints.push(key);
        } else if (key === 'select') {
          if (text === 'false') constraints.push('not selected by default');
        } else {
          constraints.push(`${key} ${trunc(text, 30)}`);
        }
      }
      for (const d of decs) {
        if (d.getName() === 'Index') {
          constraints.push(objectProp(d.getArguments().find((a) => Node.isObjectLiteralExpression(a)), 'unique')?.getText() === 'true' ? 'unique index' : 'index');
        }
      }
      const dbType = literalText(objectProp(options, 'type')) ?? (args[0] && !Node.isObjectLiteralExpression(args[0]) ? literalText(args[0]) : undefined);
      const tsType = p.getTypeNode()?.getText();
      doc.columns.push({
        name: p.getName(),
        type: trunc(dbType ? `${dbType}${tsType ? ` (${oneLine(tsType)})` : ''}` : tsType ?? '?', 50),
        constraints,
      });
    }
  }
  if (classUnique.length) doc.columns.push({ name: '(class level)', type: '', constraints: classUnique });

  for (const sub of ctx.classes) {
    if (!sub.getDecorator('EventSubscriber')) continue;
    const listenTo = sub.getInstanceMethod('listenTo');
    const text = listenTo?.getBody()?.getText() ?? '';
    if (!listenTo || new RegExp(`\\b${doc.name}\\b`).test(text)) {
      doc.subscribers.push(`${sub.getName()}${listenTo ? '' : ' (all entities)'}`);
    }
  }
  return doc;
}
