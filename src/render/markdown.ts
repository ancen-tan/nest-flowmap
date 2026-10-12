import { AppDoc, EndpointDoc, FieldRule, Loc } from '../model';
import { LIGHT, withColours } from './mermaid';

export interface LinkOptions {
  /** Template for source links, e.g. https://git.example.com/app/-/blob/main/{path}#L{line} */
  sourceUrl?: string;
}

function cell(text: string | undefined): string {
  return (text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function src(loc: Loc | undefined, o: LinkOptions): string {
  if (!loc) return '';
  const text = `${loc.file}:${loc.line}`;
  if (!o.sourceUrl) return `\`${text}\``;
  return `[\`${text}\`](${o.sourceUrl.replace('{path}', loc.file).replace('{line}', String(loc.line))})`;
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

function fieldRows(fields: FieldRule[], prefix = ''): string[][] {
  return fields.flatMap((f) => [
    [`\`${prefix}${f.name}\``, `\`${f.type}\``, f.required ? 'required' : 'optional', f.rules.map((r) => `\`${r}\``).join(' '), f.note ?? ''],
    ...(f.nested ? fieldRows(f.nested, `${prefix}${f.name}.`) : []),
  ]);
}

export function endpointMarkdown(ep: EndpointDoc, o: LinkOptions = {}): string {
  const out: string[] = [];
  out.push(`# ${ep.method} ${ep.path}`, '');
  out.push(`\`${ep.handler}\` · ${src(ep.loc, o)}`, '');
  if (ep.summary) out.push(`> ${ep.summary}`, '');
  if (ep.metadata.length) out.push(`Decorators: ${ep.metadata.map((m) => `\`${m}\``).join(' ')}`, '');

  out.push('## Flow', '', '```mermaid', `%%{init: {"flowchart": {"curve": "step"}}}%%\n${withColours(ep.mermaid.flowFlat, LIGHT)}`, '```', '');

  if (ep.pipeline.length) {
    out.push('## Middleware, guards, interceptors, pipes', '');
    out.push(
      table(
        ['#', 'Type', 'Name', 'Scope', 'Note', 'Source'],
        ep.pipeline.map((p, i) => [String(i + 1), p.kind, `\`${p.name}\``, p.scope, p.note ?? '', src(p.loc, o)]),
      ),
      '',
    );
  }

  const validated = ep.params.filter((p) => p.fields.length || p.pipes.length || p.in !== 'custom');
  if (validated.length) {
    out.push('## Validation', '');
    for (const p of ep.params) {
      const title = `${p.in}${p.key ? ` \`${p.key}\`` : ''}`;
      out.push(`### ${title}: \`${p.dto ?? p.type}\`${p.pipes.length ? ` · pipes: ${p.pipes.map((x) => `\`${x}\``).join(' ')}` : ''}`, '');
      if (p.fields.length) out.push(table(['Field', 'Type', 'Required', 'Rules', 'Note'], fieldRows(p.fields)), '');
    }
  }

  if (ep.entities.length) {
    out.push('## Entities', '');
    for (const e of ep.entities) {
      out.push(`### ${e.name}${e.table ? ` (table \`${e.table}\`)` : ''} · ${src(e.loc, o)}`, '');
      out.push(`Operations in this flow: ${e.ops.map((x) => `\`${x}()\``).join(' ') || 'none'}`, '');
      if (e.columns.length) out.push(table(['Column', 'Type', 'Constraints'], e.columns.map((c) => [`\`${c.name}\``, c.type ? `\`${c.type}\`` : '', c.constraints.join(', ')])), '');
      if (e.relations.length) out.push(`Relations: ${e.relations.map((r) => `\`${r.name}\` ${r.kind} → ${r.target}`).join('; ')}`, '');
      if (e.hooks.length) out.push(`Entity hooks: ${e.hooks.map((h) => `\`@${h.event} ${h.method}\``).join(', ')}`, '');
      if (e.subscribers.length) out.push(`Subscribers: ${e.subscribers.join(', ')}`, '');
    }
  }

  out.push(ep.kind === 'http' ? '## Responses' : '## Outcomes', '');
  if (ep.returnType) out.push(`Return type: \`${ep.returnType}\``, '');
  out.push(
    table(
      ['Status', 'Result', 'When', 'Raised in', 'Source'],
      ep.responses.map((r) => [r.status ? String(r.status) : r.kind === 'success' ? 'ok' : 'varies', r.label, r.when, r.origin, src(r.loc, o)]),
    ),
    '',
  );
  if (ep.responseFields?.length) {
    out.push('Response fields:', '', table(['Field', 'Type', 'Note'], ep.responseFields.map((f) => [`\`${f.name}\``, `\`${f.type}\``, f.note ?? ''])), '');
  }
  if (ep.declaredResponses.length) out.push(`Declared with Swagger decorators: ${ep.declaredResponses.join(', ')}`, '');

  if (ep.warnings.length) out.push('## Analysis notes', '', ...ep.warnings.map((w) => `- ${w}`), '');

  out.push('## Mindmap', '', '```mermaid', ep.mermaid.mindmap, '```', '');
  return out.join('\n');
}

export function indexMarkdown(app: AppDoc): string {
  const out: string[] = [`# ${app.name}: endpoint flow maps`, ''];
  const facts: string[] = [];
  if (app.globalPrefix) facts.push(`global prefix \`${app.globalPrefix}\``);
  if (app.versioning) facts.push(`versioning ${app.versioning}`);
  if (app.validationPipe) facts.push(`global \`${app.validationPipe}\``);
  if (facts.length) out.push(facts.join(' · '), '');
  out.push(
    table(
      ['Method', 'Path', 'Handler', 'Guards', 'Responses'],
      app.endpoints.map((ep) => [
        ep.method,
        `[${ep.path}](endpoints/${ep.id}.md)`,
        `\`${ep.handler}\``,
        ep.pipeline.filter((p) => p.kind === 'guard').map((p) => p.name).join(', '),
        [...new Set(ep.responses.map((r) => (r.status ? String(r.status) : r.kind === 'success' ? 'ok' : ep.kind === 'http' ? 'varies' : 'fail')))].join(' '),
      ]),
    ),
    '',
  );
  if (app.warnings.length) out.push('## Analysis notes', '', ...app.warnings.map((w) => `- ${w}`), '');
  out.push('## Overview', '', '```mermaid', app.overviewMindmap, '```', '');
  return out.join('\n');
}
