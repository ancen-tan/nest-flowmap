import { ClassDeclaration, MethodDeclaration, Node } from 'ts-morph';
import { FieldRule, ParamDoc } from '../model';
import { Ctx, literalList, literalText, locOf, oneLine, resolveClass, resolveIdentifier, resolveTypeNode, trunc, unwrap } from '../project';
import { parseRef } from './app-config';

/** Property decorators that are not class-validator rules. */
const NOT_A_RULE = /^(Api\w*|Type|Transform|Expose|Exclude|Field|HideField|Column|PrimaryColumn|PrimaryGeneratedColumn|JoinColumn|Prop)$/;
const SOURCES: Record<string, ParamDoc['in']> = { Body: 'body', Query: 'query', Param: 'param', Headers: 'headers' };
const FRAMEWORK_PARAMS = /^(Req|Request|Res|Response|Next|Session|Ip|HostParam|Context|Args|Payload|Ctx)$/;

/** Reads class-validator rules from a DTO, following mapped types (PartialType, PickType, OmitType, IntersectionType). */
export function dtoFields(ctx: Ctx, cls: ClassDeclaration, seen: Set<ClassDeclaration> = new Set()): FieldRule[] {
  if (seen.has(cls)) return [];
  seen.add(cls);
  const fields = new Map<string, FieldRule>();
  const ext = cls.getExtends();
  if (ext) for (const f of heritageFields(ctx, ext.getExpression(), seen)) fields.set(f.name, f);

  for (const p of cls.getInstanceProperties()) {
    if (!Node.isPropertyDeclaration(p)) continue;
    const decs = p.getDecorators();
    const names = decs.map((d) => d.getName());
    const validators = decs.filter((d) => !NOT_A_RULE.test(d.getName()));
    const optional = names.includes('IsOptional');
    const rules = validators
      .filter((d) => d.getName() !== 'IsOptional')
      .map((d) => {
        const args = d.getArguments().map((a) => oneLine(a.getText())).join(', ');
        return d.getName() + (args ? `(${trunc(args, 40)})` : '');
      });

    let note: string | undefined;
    if (!validators.length) note = 'no validators: not checked';
    else if (names.includes('ValidateIf')) note = 'conditional (ValidateIf)';
    else if (p.hasQuestionToken() && !optional) note = 'typed optional, but validated as required';

    let nested: FieldRule[] | undefined;
    if (names.includes('ValidateNested')) {
      const typeDec = decs.find((d) => d.getName() === 'Type');
      const factory = typeDec?.getArguments()[0];
      const target = factory && Node.isArrowFunction(factory) ? resolveClass(ctx, factory.getBody()) : undefined;
      const fromType = target ?? resolveTypeNode(ctx, elementType(p.getTypeNode()));
      if (fromType && Node.isClassDeclaration(fromType)) nested = dtoFields(ctx, fromType, new Set(seen));
    }

    const enumArg = decs.find((d) => d.getName() === 'IsEnum')?.getArguments()[0];
    const values = enumArg ? enumValues(ctx, enumArg) : undefined;

    fields.set(p.getName(), {
      name: p.getName(),
      type: trunc(p.getTypeNode()?.getText() ?? 'unknown', 40),
      required: validators.length > 0 && !optional,
      rules,
      ...(values?.length && { values }),
      note,
      nested,
    });
  }
  return [...fields.values()];
}

/** Values of a TypeScript enum, or of a `const X = { ... } as const` object used as one. */
function enumValues(ctx: Ctx, node: Node): (string | number)[] | undefined {
  const d = resolveIdentifier(ctx, unwrap(node));
  if (d && Node.isEnumDeclaration(d)) {
    return d.getMembers().map((m) => m.getValue()).filter((v): v is string | number => v !== undefined);
  }
  const init = d && Node.isVariableDeclaration(d) ? d.getInitializer() : undefined;
  const obj = init && unwrap(init);
  if (obj && Node.isObjectLiteralExpression(obj)) {
    return obj.getProperties().flatMap((p) => {
      const v = Node.isPropertyAssignment(p) ? literalText(p.getInitializer()) : undefined;
      return v === undefined ? [] : [v];
    });
  }
  return undefined;
}

function elementType(t: Node | undefined): any {
  if (t && Node.isArrayTypeNode(t)) return t.getElementTypeNode();
  return t;
}

function heritageFields(ctx: Ctx, expr: Node, seen: Set<ClassDeclaration>): FieldRule[] {
  const e = unwrap(expr);
  if (Node.isIdentifier(e)) {
    const cls = resolveClass(ctx, e);
    return cls ? dtoFields(ctx, cls, seen) : [];
  }
  if (!Node.isCallExpression(e)) return [];
  const fn = e.getExpression().getText();
  const args = e.getArguments();
  const base = args[0] ? heritageFields(ctx, args[0], seen) : [];
  if (fn === 'PartialType') return base.map((f) => ({ ...f, required: false, note: 'optional via PartialType' }));
  if (fn === 'PickType') {
    const keys = literalList(args[1]);
    return base.filter((f) => keys.includes(f.name));
  }
  if (fn === 'OmitType') {
    const keys = literalList(args[1]);
    return base.filter((f) => !keys.includes(f.name));
  }
  if (fn === 'IntersectionType') return args.flatMap((a) => heritageFields(ctx, a, seen));
  return base;
}

export interface ParamInfo extends ParamDoc {
  /** True when the parameter is the raw response object (`@Res()`). */
  rawResponse?: boolean;
  hasRules: boolean;
}

export function describeParams(ctx: Ctx, method: MethodDeclaration): ParamInfo[] {
  const out: ParamInfo[] = [];
  for (const p of method.getParameters()) {
    const decs = p.getDecorators();
    const type = trunc(p.getTypeNode()?.getText() ?? 'unknown', 50);
    const source = decs.find((d) => SOURCES[d.getName()]);
    if (!source) {
      const d = decs[0];
      if (d && /^(Res|Response)$/.test(d.getName())) {
        out.push({ in: 'custom', name: p.getName(), type, pipes: [], fields: [], rawResponse: true, hasRules: false });
      } else if (d && !FRAMEWORK_PARAMS.test(d.getName())) {
        out.push({ in: 'custom', name: p.getName(), key: `@${d.getName()}()`, type, pipes: [], fields: [], hasRules: false, loc: locOf(ctx, p) });
      }
      continue;
    }
    const args = source.getArguments();
    const key = literalText(args[0]);
    const pipes = args.filter((a, i) => !(i === 0 && key !== undefined)).map((a) => parseRef(ctx, a).name);
    const dto = resolveTypeNode(ctx, elementType(p.getTypeNode()));
    const fields = dto && Node.isClassDeclaration(dto) ? dtoFields(ctx, dto) : [];
    out.push({
      in: SOURCES[source.getName()],
      name: p.getName(),
      key,
      type,
      dto: fields.length && dto ? dto.getName() : undefined,
      pipes,
      fields,
      hasRules: fields.some((f) => f.rules.length > 0 || f.nested?.length),
      loc: locOf(ctx, p),
    });
  }
  return out;
}
