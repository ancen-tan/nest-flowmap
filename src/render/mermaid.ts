import { EndpointDoc, FieldRule, GEdge, GNode, Graph } from '../model';

export interface Palette {
  [cls: string]: { fill: string; stroke: string; text: string; dash?: boolean };
}

export const LIGHT: Palette = {
  request: { fill: '#e8eaf6', stroke: '#3949ab', text: '#111111' },
  middleware: { fill: '#fff3e0', stroke: '#ef6c00', text: '#111111' },
  validation: { fill: '#f3e5f5', stroke: '#8e24aa', text: '#111111' },
  controller: { fill: '#e3f2fd', stroke: '#1e88e5', text: '#111111' },
  service: { fill: '#e8f5e9', stroke: '#43a047', text: '#111111' },
  entity: { fill: '#fff8e1', stroke: '#f9a825', text: '#111111' },
  external: { fill: '#e0f7fa', stroke: '#00838f', text: '#111111' },
  response: { fill: '#eceff1', stroke: '#546e7a', text: '#111111' },
  catch: { fill: '#fce4ec', stroke: '#c2185b', text: '#111111', dash: true },
  ok: { fill: '#c8e6c9', stroke: '#2e7d32', text: '#111111' },
  err: { fill: '#ffcdd2', stroke: '#c62828', text: '#111111' },
  note: { fill: '#f5f5f5', stroke: '#9e9e9e', text: '#333333', dash: true },
};

export const DARK: Palette = {
  request: { fill: '#283593', stroke: '#9fa8da', text: '#ffffff' },
  middleware: { fill: '#7a3d00', stroke: '#ffb74d', text: '#ffffff' },
  validation: { fill: '#5e2a70', stroke: '#ce93d8', text: '#ffffff' },
  controller: { fill: '#0d47a1', stroke: '#90caf9', text: '#ffffff' },
  service: { fill: '#1b5e20', stroke: '#a5d6a7', text: '#ffffff' },
  entity: { fill: '#6b5200', stroke: '#ffe082', text: '#ffffff' },
  external: { fill: '#004d57', stroke: '#80deea', text: '#ffffff' },
  response: { fill: '#37474f', stroke: '#b0bec5', text: '#ffffff' },
  catch: { fill: '#6a1b3a', stroke: '#f48fb1', text: '#ffffff', dash: true },
  ok: { fill: '#1e6b23', stroke: '#a5d6a7', text: '#ffffff' },
  err: { fill: '#8e1c1c', stroke: '#ef9a9a', text: '#ffffff' },
  note: { fill: '#2b2b2b', stroke: '#9e9e9e', text: '#dddddd', dash: true },
};

export function classDefs(p: Palette): string {
  return Object.entries(p)
    .map(([cls, c]) => `  classDef ${cls} fill:${c.fill},stroke:${c.stroke},color:${c.text}${c.dash ? ',stroke-dasharray:4 3' : ''};`)
    .join('\n');
}

/**
 * Flowchart source without colour definitions (the viewer adds its own for light / dark).
 * With `lanes`, nodes are grouped into one box per layer.
 *
 * The viewer runs this function's source in the browser, so it must stay self-contained: no
 * references to anything outside its body.
 */
export function flowchart(graph: Graph, lanes: boolean): string {
  const layers: [string, string][] = [
    ['request', 'Request'],
    ['middleware', 'Middleware, guards, interceptors'],
    ['validation', 'Validation (pipes)'],
    ['controller', 'Controller'],
    ['service', 'Service'],
    ['entity', 'Entity / database'],
    ['external', 'External / async'],
    ['response', 'Response'],
  ];
  // Makes arbitrary source text safe inside a quoted Mermaid label.
  const esc = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '#quot;').replace(/`/g, "'"))
      .join('<br/>');
  const shape = (n: GNode) => {
    const t = `"${esc(n.label)}"`;
    switch (n.shape) {
      case 'stadium':
        return `${n.id}([${t}])`;
      case 'sub':
        return `${n.id}[[${t}]]`;
      case 'decision':
        return `${n.id}{${t}}`;
      case 'db':
        return `${n.id}[(${t})]`;
      case 'io':
        return `${n.id}[/${t}/]`;
      case 'hex':
        return `${n.id}{{${t}}}`;
      default:
        return `${n.id}[${t}]`;
    }
  };

  const out: string[] = ['flowchart TD'];
  if (lanes) {
    for (const [id, title] of layers) {
      const nodes = graph.nodes.filter((n) => n.layer === id);
      if (!nodes.length) continue;
      out.push(`  subgraph L_${id}["${esc(title)}"]`);
      for (const n of nodes) out.push(`    ${shape(n)}`);
      out.push('  end');
    }
  } else {
    for (const n of graph.nodes) out.push(`  ${shape(n)}`);
  }
  for (const e of graph.edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    out.push(`  ${e.from} ${arrow}${e.label ? `|"${esc(e.label)}"|` : ''} ${e.to}`);
  }
  const byClass = new Map<string, string[]>();
  for (const n of graph.nodes) byClass.set(n.cls, [...(byClass.get(n.cls) ?? []), n.id]);
  for (const [cls, ids] of byClass) out.push(`  class ${ids.join(',')} ${cls};`);
  return out.join('\n');
}

/**
 * Folds the bodies of the scope nodes (calls, guards, middleware, the handler) that are not in
 * `expanded` into the node itself. Edges into or out of a folded body are moved to the folded node;
 * edges that end up inside one folded node are dropped, and an edge keeps its label only while its own
 * source is still drawn. A folded node gets a "▸ N more steps" line.
 *
 * Error responses reached only from inside folded calls are merged per status
 * ("422 Unprocessable Entity · 8 reasons"), since their individual causes are hidden anyway; the details tab still lists each one. Otherwise a folded call that can fail in twenty ways
 * would draw twenty boxes side by side.
 *
 * Self-contained: the viewer runs this in the browser.
 */
export function collapseGraph(graph: Graph, expanded: string[]): Graph {
  const open = new Set(expanded);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const rep = new Map<string, string>();
  const shownAs = (id: string): string => {
    let r = rep.get(id);
    if (r) return r;
    r = id;
    // The outermost folded ancestor stands in for the node.
    for (let up = byId.get(id)?.scope; up; up = byId.get(up)?.scope) if (!open.has(up)) r = up;
    rep.set(id, r);
    return r;
  };
  const hidden = new Map<string, number>();
  for (const n of graph.nodes) {
    const r = shownAs(n.id);
    if (r !== n.id) hidden.set(r, (hidden.get(r) ?? 0) + 1);
  }
  const nodes = graph.nodes
    .filter((n) => shownAs(n.id) === n.id)
    .map((n) => {
      const count = hidden.get(n.id);
      return count ? { ...n, label: `${n.label}\n▸ ${count} more step${count === 1 ? '' : 's'}` } : n;
    });

  const edges: GEdge[] = [];
  const seen = new Map<string, GEdge>();
  for (const e of graph.edges) {
    const from = shownAs(e.from);
    const to = shownAs(e.to);
    if (from === to && !(e.from === e.to && from === e.from)) continue; // folded into one node
    const label = from === e.from ? e.label : undefined;
    const key = `${from}>${to}>${label ?? ''}`;
    const prev = seen.get(key);
    if (prev) {
      if (!e.dashed) delete prev.dashed;
      continue;
    }
    const edge: GEdge = { from, to, ...(label && { label }), ...(e.dashed && { dashed: true }) };
    seen.set(key, edge);
    edges.push(edge);
  }

  // Merge error responses whose every incoming edge was moved onto a folded call.
  const into = new Map<string, { from: Set<string>; direct: boolean }>();
  for (const e of graph.edges) {
    const target = byId.get(e.to);
    if (!target || target.cls !== 'err' || shownAs(e.to) !== e.to) continue;
    const from = shownAs(e.from);
    if (from === e.to) continue;
    const entry = into.get(e.to) ?? { from: new Set<string>(), direct: false };
    entry.from.add(from);
    if (from === e.from) entry.direct = true;
    into.set(e.to, entry);
  }
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const entry = into.get(n.id);
    if (!entry || entry.direct) continue;
    const key = n.label.split('\n')[0];
    groups.set(key, [...(groups.get(key) ?? []), n.id]);
  }
  const mergedInto = new Map<string, string>();
  const relabel = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const reasons = ids.map((id) => (byId.get(id)?.label.split('\n')[1] ?? '').split(':')[0]).filter(Boolean);
    const names = [...new Set(reasons)];
    const listed = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', ');
    relabel.set(ids[0], `${byId.get(ids[0])!.label.split('\n')[0]} · ${ids.length} reasons\n${listed}`);
    for (const id of ids.slice(1)) mergedInto.set(id, ids[0]);
  }
  if (!mergedInto.size) return { nodes, edges };
  const mergedNodes = nodes.filter((n) => !mergedInto.has(n.id)).map((n) => (relabel.has(n.id) ? { ...n, label: relabel.get(n.id)! } : n));
  const mergedEdges: GEdge[] = [];
  const keys = new Set<string>();
  for (const e of edges) {
    const to = mergedInto.get(e.to) ?? e.to;
    const key = `${e.from}>${to}>${e.label ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    mergedEdges.push(to === e.to ? e : { ...e, to });
  }
  return { nodes: mergedNodes, edges: mergedEdges };
}

/**
 * The scope nodes to show expanded at first: entry handlers always, then other bodies in
 * breadth-first order while the diagram stays within `budget` nodes. Small diagrams come out
 * fully expanded, large ones at the level of the calls the handler makes.
 *
 * Self-contained apart from `collapseGraph`, which the viewer defines next to it.
 */
export function defaultExpanded(graph: Graph, budget: number): string[] {
  const owners = new Set(graph.nodes.map((n) => n.scope).filter((s): s is string => !!s));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depth = (id: string) => {
    let d = 0;
    for (let up = byId.get(id)?.scope; up; up = byId.get(up)?.scope) d++;
    return d;
  };
  const order = graph.nodes.filter((n) => owners.has(n.id)).sort((a, b) => depth(a.id) - depth(b.id));
  const open = order.filter((n) => !n.scope && n.shape === 'sub').map((n) => n.id);
  for (const n of order) {
    if (open.includes(n.id)) continue;
    // A body only fits if its parent is open; otherwise opening it would show nothing.
    if (n.scope && !open.includes(n.scope)) continue;
    if (collapseGraph(graph, [...open, n.id]).nodes.length <= budget) open.push(n.id);
  }
  return open;
}

export function withColours(source: string, palette: Palette = LIGHT): string {
  return `${source}\n${classDefs(palette)}`;
}

// ---------------------------------------------------------------------------------------------
// Mindmaps

function mm(text: string): string {
  // Mindmap labels are plain text inside ["..."]; keep them on one line and free of quotes.
  // `*` would be read as Markdown emphasis.
  return text.replace(/\s+/g, ' ').replace(/"/g, "'").replace(/`/g, "'").replace(/[<>]/g, ' ').replace(/\*/g, '∗').trim();
}

function leaf(depth: number, text: string, round = false): string {
  const t = mm(text);
  return `${'  '.repeat(depth)}${round ? `("${t}")` : `["${t}"]`}`;
}

function fieldLine(f: FieldRule): string {
  return `${f.name}: ${f.required ? 'required' : 'optional'}${f.rules.length ? ` · ${f.rules.slice(0, 3).join(', ')}` : ''}`;
}

export function endpointMindmap(ep: EndpointDoc): string {
  const out: string[] = ['mindmap', `  root(("${mm(`${ep.method} ${ep.path}`)}"))`];
  const section = (title: string, items: string[], limit = 12) => {
    if (!items.length) return;
    out.push(`    ${title}`);
    const unique = [...new Set(items)];
    for (const i of unique.slice(0, limit)) out.push(leaf(3, i));
    if (unique.length > limit) out.push(leaf(3, `+ ${unique.length - limit} more`));
  };

  if (ep.params.some((p) => p.fields.length || p.pipes.length)) {
    out.push('    Validation');
    for (const p of ep.params) {
      if (!p.fields.length && !p.pipes.length) continue;
      out.push(leaf(3, `${p.in}${p.key ? ` '${p.key}'` : ''}${p.dto ? `: ${p.dto}` : ''}${p.pipes.length ? ` · ${p.pipes.join(', ')}` : ''}`, true));
      for (const f of p.fields.slice(0, 10)) out.push(leaf(4, fieldLine(f)));
      if (p.fields.length > 10) out.push(leaf(4, `+ ${p.fields.length - 10} more`));
    }
  }
  section('Middleware', ep.pipeline.filter((p) => p.kind !== 'pipe' && p.kind !== 'filter').map((p) => `${p.kind}: ${p.name}`));
  const labels = (layer: string, shapes: string[]) =>
    ep.graph.nodes.filter((n) => n.layer === layer && shapes.includes(n.shape)).map((n) => n.label.replace(/\n/g, ' · '));
  section('Controller', [ep.handler, ...labels('controller', ['decision'])]);
  section('Service', labels('service', ['sub', 'decision', 'hex']));
  section('Entity', [...labels('entity', ['db', 'sub']), ...ep.entities.map((e) => `${e.name}${e.table ? ` (table ${e.table})` : ''}`)]);
  section('External', labels('external', ['io']));
  section(
    ep.kind === 'http' ? 'Responses' : 'Outcomes',
    ep.responses.map((r) => (r.kind === 'success' ? r.label : `${r.status ?? ''} ${r.label}${r.when ? `: ${r.when}` : ''}`.trim())),
    16,
  );
  return out.join('\n');
}

export function overviewMindmap(name: string, endpoints: EndpointDoc[]): string {
  const out: string[] = ['mindmap', `  root(("${mm(name)}"))`];
  const groups = new Map<string, EndpointDoc[]>();
  for (const ep of endpoints) groups.set(ep.group, [...(groups.get(ep.group) ?? []), ep]);
  for (const [group, eps] of groups) {
    out.push(leaf(2, group, true));
    for (const ep of eps) out.push(leaf(3, `${ep.method} ${ep.path}`));
  }
  return out.join('\n');
}
