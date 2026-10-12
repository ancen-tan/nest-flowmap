import { ClassDeclaration, Decorator, MethodDeclaration, Node, PropertyDeclaration, SyntaxKind } from 'ts-morph';
import { FieldRule, ParamDoc } from '../model';
import { Ctx, literalText, locOf, objectProp, oneLine, resolveClass, resolveIdentifier, resolveTypeNode, trunc, unwrap } from '../project';
import { parseRef } from './app-config';

/** Property decorators that are not class-validator rules. */
const NOT_A_RULE = /^(Api\w*|Type|Transform|Expose|Exclude|Field|HideField|Column|PrimaryColumn|PrimaryGeneratedColumn|JoinColumn|Prop)$/;
const SOURCES: Record<string, ParamDoc['in']> = { Body: 'body', Query: 'query', Param: 'param', Headers: 'headers' };
const NUMERIC_RULES = /^(Min|Max|MinLength|MaxLength|Length|ArrayMinSize|ArrayMaxSize)$/;
const FRAMEWORK_PARAMS = /^(Req|Request|Res|Response|Next|Session|Ip|HostParam|Context|Args|Payload|Ctx)$/;

/**
 * class-validator groups decorators by type, and a subclass that redeclares a property only replaces
 * the parent's metadata of the types it declares itself (so a parent's @IsOptional survives a child's @Max).
 */
type RuleKind = 'conditional' | 'custom' | 'nested' | 'whitelist' | 'defined';

interface Rule {
  name: string;
  text: string;
  kind: RuleKind;
  node: Decorator;
}

interface RawField {
  prop: string;
  wire: string;
  type: string;
  rules: Rule[];
  nested?: FieldRule[];
  dto?: string;
  values?: (string | number | boolean)[];
  json?: boolean;
  /** Made optional by PartialType. */
  partial?: boolean;
}

function kindOf(name: string): RuleKind {
  if (name === 'IsOptional' || name === 'ValidateIf') return 'conditional';
  if (name === 'ValidateNested') return 'nested';
  if (name === 'Allow') return 'whitelist';
  if (name === 'IsDefined') return 'defined';
  return 'custom';
}

/** Reads class-validator rules from a DTO, following mapped types (PartialType, PickType, OmitType, IntersectionType). */
export function dtoFields(ctx: Ctx, cls: ClassDeclaration, seen: Set<ClassDeclaration> = new Set()): FieldRule[] {
  return rawFields(ctx, cls, seen).map(finish);
}

function rawFields(ctx: Ctx, cls: ClassDeclaration, seen: Set<ClassDeclaration>): RawField[] {
  if (seen.has(cls)) return [];
  const inner = new Set(seen).add(cls);
  const fields = new Map<string, RawField>();
  const ext = cls.getExtends();
  if (ext) for (const f of heritage(ctx, ext.getExpression(), inner)) fields.set(f.prop, f);

  for (const p of cls.getInstanceProperties()) {
    if (!Node.isPropertyDeclaration(p)) continue;
    const own = ownField(ctx, p, inner);
    const parent = fields.get(own.prop);
    if (parent) {
      const declared = new Set(own.rules.map((r) => r.kind));
      own.rules = [...parent.rules.filter((r) => !declared.has(r.kind)), ...own.rules];
      own.nested ??= parent.nested;
      own.dto ??= parent.dto;
      own.values ??= parent.values;
      own.partial = parent.partial && !declared.has('conditional');
    }
    fields.set(own.prop, own);
  }
  return [...fields.values()];
}

function ownField(ctx: Ctx, p: PropertyDeclaration, seen: Set<ClassDeclaration>): RawField {
  const decs = p.getDecorators();
  const rules: Rule[] = decs
    .filter((d) => !NOT_A_RULE.test(d.getName()))
    .map((d) => {
      const args = d
        .getArguments()
        .map((a) => {
          const text = oneLine(a.getText());
          // `@Max(MAX_AMOUNT)`: keep the constant's name and record its value for the schema.
          const u = unwrap(a);
          const value = NUMERIC_RULES.test(d.getName()) && (Node.isIdentifier(u) || Node.isPropertyAccessExpression(u)) ? literalText(u) : undefined;
          return value !== undefined && /^-?\d+(\.\d+)?$/.test(value) ? `${text} = ${value}` : text;
        })
        .join(', ');
      return { name: d.getName(), text: d.getName() + (args ? `(${trunc(args, 100)})` : ''), kind: kindOf(d.getName()), node: d };
    });

  // The name on the wire: class-transformer's @Expose({ name }) or Swagger's @ApiProperty({ name }).
  const named = (dec: string) => literalText(objectProp(decs.find((d) => d.getName() === dec)?.getArguments()[0], 'name'));
  const wire = named('Expose') ?? named('ApiProperty') ?? named('ApiPropertyOptional') ?? p.getName();

  let nested: FieldRule[] | undefined;
  let dto: string | undefined;
  if (rules.some((r) => r.name === 'ValidateNested')) {
    const typeDec = decs.find((d) => d.getName() === 'Type');
    const factory = typeDec?.getArguments()[0];
    const target = factory && Node.isArrowFunction(factory) ? resolveClass(ctx, factory.getBody()) : undefined;
    const fromType = target ?? resolveTypeNode(ctx, elementType(p.getTypeNode()));
    if (fromType && Node.isClassDeclaration(fromType)) {
      nested = dtoFields(ctx, fromType, seen);
      dto = fromType.getName();
    }
  }

  const valueRule = rules.find((r) => r.name === 'IsEnum' || r.name === 'IsIn' || r.name === 'Equals');
  const valueArg = valueRule?.node.getArguments()[0];
  const values = valueArg ? (valueRule!.name === 'Equals' ? [literalValue(valueArg)].filter((v) => v !== undefined) : allowedValues(ctx, valueArg)) : undefined;

  // `@Transform(({ value }) => JSON.parse(value))`: the query string carries JSON text.
  const json = decs.some((d) => d.getName() === 'Transform' && /JSON\.parse/.test(d.getText()));

  return {
    prop: p.getName(),
    wire,
    type: trunc(p.getTypeNode()?.getText() ?? 'unknown', 120),
    rules,
    ...(nested && { nested, dto }),
    ...(values?.length && { values: values as (string | number | boolean)[] }),
    ...(json && { json }),
  };
}

function finish(f: RawField): FieldRule {
  const has = (name: string) => f.rules.some((r) => r.name === name);
  const conditional = has('ValidateIf');
  const optional = has('IsOptional') || f.partial;
  // A field is checked when undefined unless it is optional or conditional; @Allow and @IsEmpty do not require a value.
  const constraints = f.rules.filter((r) => r.kind !== 'conditional' && r.name !== 'Allow' && r.name !== 'IsEmpty');
  const required = constraints.length > 0 && !optional && !conditional;
  const notes: string[] = [];
  if (!f.rules.length) notes.push('no validators: not checked');
  if (conditional) notes.push('conditional (ValidateIf)');
  if (has('IsEmpty')) notes.push('must be empty or absent');
  if (f.partial && !has('IsOptional') && f.rules.length) notes.push('optional via PartialType');
  if (f.wire !== f.prop) notes.push(`property ${f.prop}`);
  if (f.json) notes.push(`JSON-encoded ${f.type}`);
  return {
    name: f.wire,
    type: f.json ? 'string' : f.type,
    required,
    rules: f.rules.filter((r) => r.name !== 'IsOptional').map((r) => r.text),
    ...(f.values && { values: f.values }),
    ...(f.dto && !f.json && { dto: f.dto }),
    note: notes.join('; ') || undefined,
    ...(f.nested && !f.json && { nested: f.nested }),
  };
}

function heritage(ctx: Ctx, expr: Node, seen: Set<ClassDeclaration>): RawField[] {
  const e = unwrap(expr);
  if (Node.isIdentifier(e)) {
    const cls = resolveClass(ctx, e);
    return cls ? rawFields(ctx, cls, seen) : [];
  }
  if (!Node.isCallExpression(e)) return [];
  const fn = e.getExpression().getText();
  const args = e.getArguments();
  // Each branch gets its own copy of `seen`: IntersectionType(A, B) must read both A and B.
  if (fn === 'IntersectionType') return args.flatMap((a) => heritage(ctx, a, new Set(seen)));
  const base = args[0] ? heritage(ctx, args[0], new Set(seen)) : [];
  if (fn === 'PartialType') return base.map((f) => ({ ...f, partial: true }));
  if (fn === 'PickType' || fn === 'OmitType') {
    const keys = (allowedValues(ctx, args[1]) ?? []).map(String);
    return base.filter((f) => keys.includes(f.prop) === (fn === 'PickType'));
  }
  return base;
}

function elementType(t: Node | undefined): any {
  if (t && Node.isArrayTypeNode(t)) return t.getElementTypeNode();
  return t;
}

/** A literal's value with its type: 'a', 2, true; enum members and constants are followed. */
function literalValue(node: Node | undefined): string | number | boolean | undefined {
  if (!node) return undefined;
  const n = unwrap(node);
  if (n.getKind() === SyntaxKind.TrueKeyword) return true;
  if (n.getKind() === SyntaxKind.FalseKeyword) return false;
  if (Node.isNumericLiteral(n)) return n.getLiteralValue();
  if (Node.isPrefixUnaryExpression(n) && Node.isNumericLiteral(n.getOperand())) {
    const v = (n.getOperand() as import('ts-morph').NumericLiteral).getLiteralValue();
    return n.getOperatorToken() === SyntaxKind.MinusToken ? -v : v;
  }
  const text = literalText(n);
  if (text === undefined) return undefined;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return text;
  // A constant or enum member: keep numbers numeric.
  try {
    const t = n.getType();
    if (t.isNumberLiteral()) return Number(text);
  } catch {
    /* unresolved */
  }
  return /^-?\d+(\.\d+)?$/.test(text) && isNumericEnumMember(n) ? Number(text) : text;
}

function isNumericEnumMember(n: Node): boolean {
  try {
    let sym = n.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol();
    return !!sym?.getDeclarations().some((d) => Node.isEnumMember(d) && typeof d.getValue() === 'number');
  } catch {
    return false;
  }
}

/**
 * Allowed values for IsEnum / IsIn and key lists for PickType / OmitType: an enum, an array or object
 * literal, a constant holding one (`as const` or not), or `Object.values(X)`.
 */
function allowedValues(ctx: Ctx, node: Node | undefined, depth = 0): (string | number | boolean)[] | undefined {
  if (!node || depth > 5) return undefined;
  const n = unwrap(node);
  if (Node.isArrayLiteralExpression(n)) {
    const out: (string | number | boolean)[] = [];
    for (const el of n.getElements()) {
      const v = literalValue(el);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (Node.isObjectLiteralExpression(n)) {
    const out: (string | number | boolean)[] = [];
    for (const p of n.getProperties()) {
      const v = Node.isPropertyAssignment(p) ? literalValue(p.getInitializer()) : undefined;
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (Node.isCallExpression(n) && /^Object\.values$/.test(n.getExpression().getText())) return allowedValues(ctx, n.getArguments()[0], depth + 1);
  if (Node.isIdentifier(n) || Node.isPropertyAccessExpression(n)) {
    const id = Node.isPropertyAccessExpression(n) ? n.getNameNode() : n;
    const d = resolveIdentifier(ctx, id) ?? declarationOf(n);
    if (d && Node.isEnumDeclaration(d)) {
      return d.getMembers().map((m) => m.getValue()).filter((v): v is string | number => v !== undefined);
    }
    if (d && Node.isVariableDeclaration(d)) return allowedValues(ctx, d.getInitializer(), depth + 1);
    if (d && Node.isPropertyAssignment(d)) return allowedValues(ctx, d.getInitializer(), depth + 1);
  }
  return undefined;
}

function declarationOf(n: Node): Node | undefined {
  try {
    let sym = n.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol();
    return sym?.getDeclarations().find((d) => !d.getSourceFile().isDeclarationFile());
  } catch {
    return undefined;
  }
}

export interface ParamInfo extends ParamDoc {
  /** True when the parameter is the raw response object (`@Res()`). */
  rawResponse?: boolean;
  /** `@Res({ passthrough: true })`: Nest still sends the handler's return value. */
  passthrough?: boolean;
  /** The pipe expressions, in the same order as `pipes`. */
  pipeNodes: Node[];
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
        const passthrough = objectProp(d.getArguments()[0], 'passthrough')?.getText() === 'true';
        out.push({ in: 'custom', name: p.getName(), type, pipes: [], pipeNodes: [], fields: [], rawResponse: true, passthrough, hasRules: false });
      } else if (d && !FRAMEWORK_PARAMS.test(d.getName())) {
        const args = d.getArguments().map((a) => oneLine(a.getText())).join(', ');
        out.push({ in: 'custom', name: p.getName(), key: `@${d.getName()}(${trunc(args, 40)})`, type, pipes: [], pipeNodes: [], fields: [], hasRules: false, loc: locOf(ctx, p) });
      }
      continue;
    }
    const args = source.getArguments();
    const key = literalText(args[0]);
    const pipeNodes = args.filter((a, i) => !(i === 0 && key !== undefined));
    const dto = resolveTypeNode(ctx, elementType(p.getTypeNode()));
    const fields = dto && Node.isClassDeclaration(dto) ? dtoFields(ctx, dto) : [];
    out.push({
      in: SOURCES[source.getName()],
      name: p.getName(),
      key,
      type,
      dto: fields.length && dto ? dto.getName() : undefined,
      pipes: pipeNodes.map((a) => parseRef(ctx, a).name),
      pipeNodes,
      fields,
      hasRules: fields.some((f) => f.rules.length > 0 || f.nested?.length),
      loc: locOf(ctx, p),
    });
  }
  return out;
}
