import * as fs from 'fs';
import * as path from 'path';
import { AppDoc } from '../model';
import { assembleCollection, DEFAULT_BASE_URL, exportRequests } from './collections';
import { DARK, LIGHT, classDefs, collapseGraph, defaultExpanded, flowchart } from './mermaid';
import { assembleOpenApi, openApiParts } from './openapi';

const ASSETS = path.join(__dirname, '..', '..', '..', 'assets');

/** Functions the viewer runs as they are; each is self-contained (see their comments). */
export const VIEWER_LIB = [flowchart, collapseGraph, defaultExpanded, assembleCollection, assembleOpenApi];

/**
 * Builds the single-file viewer. Mermaid is inlined from the installed package by default so the
 * page works offline and sends nothing anywhere; pass a URL to load it from a CDN instead.
 */
export function viewerHtml(app: AppDoc, mermaidUrl?: string, serverUrl = DEFAULT_BASE_URL): string {
  const template = fs.readFileSync(path.join(ASSETS, 'viewer.html'), 'utf8');
  const data = JSON.stringify({
    // The viewer draws flowcharts itself from the graph, so it can fold calls; source locations and
    // the pre-built flowchart text are left out to keep the page small.
    app: {
      ...app,
      endpoints: app.endpoints.map(({ steps, graph, mermaid, ...rest }) => ({
        ...rest,
        mermaid: { mindmap: mermaid.mindmap },
        graph: { nodes: graph.nodes.map(({ loc, ...n }) => n), edges: graph.edges },
      })),
    },
    classDefs: { light: classDefs(LIGHT), dark: classDefs(DARK) },
    exports: { baseUrl: serverUrl, requests: exportRequests(app), openapi: openApiParts(app) },
  }).replace(/</g, '\\u003c');

  let script: string;
  if (mermaidUrl) {
    script = `<script src="${mermaidUrl.replace(/"/g, '&quot;')}"></script>`;
  } else {
    const file = path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js');
    script = `<script>${fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
  }
  // Function replacers: the payloads contain `$` sequences that String.replace would interpret.
  return template
    .replace('__TITLE__', () => escapeHtml(app.name))
    .replace('<!--__MERMAID__-->', () => script)
    .replace('__DATA__', () => data)
    .replace('/*__LIB__*/', () => VIEWER_LIB.map((f) => f.toString()).join('\n\n').replace(/<\/script/gi, '<\\/script'));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
