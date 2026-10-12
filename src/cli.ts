#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { analyze } from './analyze/endpoints';
import { AppDoc } from './model';
import { loadProject } from './project';
import { viewerHtml } from './render/html';
import { assembleOpenApi, openApiParts } from './render/openapi';
import { endpointMarkdown, indexMarkdown } from './render/markdown';

const HELP = `nest-flowmap: static per-endpoint flow maps for NestJS

Usage
  nest-flowmap [project-dir] [options]

Options
  --out <dir>          Output directory (default: flowmap)
  --tsconfig <file>    tsconfig to load (default: tsconfig.json in the project dir)
  --filter <text>      Only endpoints whose "METHOD /path" or handler contains this text
  --depth <n>          How many nested calls to follow from each handler (default: 6)
  --format <list>      Any of html,md,json,openapi (default: all four)
  --server-url <url>   Server URL written into openapi.json (default: http://localhost:3000)
  --from-json <file>   Render from a saved flowmap.json instead of analysing source
  --source-url <tpl>   Link template for source references, with {path} and {line}
  --mermaid-url <url>  Load Mermaid from this URL instead of inlining it in the viewer
  --verbose            Also draw plain statements, not only branches, calls and DB access
  --name <text>        Title used in the output (default: package.json name)
  -v, --version        Show the installed version
  -h, --help           Show this help
`;

interface Args {
  dir: string;
  out: string;
  tsconfig?: string;
  filter?: string;
  depth: number;
  formats: string[];
  sourceUrl?: string;
  mermaidUrl?: string;
  verbose: boolean;
  name?: string;
  fromJson?: string;
  serverUrl: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dir: '.', out: 'flowmap', depth: 6, formats: ['html', 'md', 'json', 'openapi'], verbose: false, serverUrl: 'http://localhost:3000' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '-v' || arg === '--version') {
      process.stdout.write(`${JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version}\n`);
      process.exit(0);
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === '--out') a.out = value();
    else if (arg === '--tsconfig') a.tsconfig = value();
    else if (arg === '--filter') a.filter = value();
    else if (arg === '--depth') a.depth = Number(value());
    else if (arg === '--format') a.formats = value().split(',').map((s) => s.trim());
    else if (arg === '--source-url') a.sourceUrl = value();
    else if (arg === '--mermaid-url') a.mermaidUrl = value();
    else if (arg === '--name') a.name = value();
    else if (arg === '--from-json') a.fromJson = value();
    else if (arg === '--server-url') a.serverUrl = value();
    else if (arg === '--verbose') a.verbose = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else a.dir = arg;
  }
  if (!Number.isInteger(a.depth) || a.depth < 0) throw new Error('--depth must be a non-negative integer');
  const known = ['html', 'md', 'json', 'openapi'];
  const bad = a.formats.filter((f) => !known.includes(f));
  if (bad.length) throw new Error(`Unknown format ${bad.join(', ')}; use any of ${known.join(',')}`);
  return a;
}

export function run(argv: string[]): AppDoc {
  const args = parseArgs(argv);
  let app: AppDoc;
  let sourceNote: string;
  if (args.fromJson) {
    app = JSON.parse(fs.readFileSync(path.resolve(args.fromJson), 'utf8'));
    if (args.name) app.name = args.name;
    sourceNote = path.relative(process.cwd(), path.resolve(args.fromJson));
  } else {
    const root = path.resolve(args.dir);
    if (!fs.existsSync(root)) throw new Error(`Project directory not found: ${root}`);

    let pkg: { name?: string; version?: string } = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch {
      /* no package.json */
    }
    const name = args.name ?? pkg.name;
    const ctx = loadProject(root, { depth: args.depth, verbose: args.verbose }, args.tsconfig);
    if (!ctx.files.length) {
      throw new Error(`No TypeScript source files found under ${root}. Pass the app directory, or --tsconfig for a non-standard layout.`);
    }
    app = analyze(ctx, name ?? path.basename(root));
    if (pkg.version) app.version = pkg.version;
    sourceNote = `${ctx.files.length} source files`;
  }
  if (args.filter) {
    const f = args.filter.toLowerCase();
    app.endpoints = app.endpoints.filter((ep) => `${ep.method} ${ep.path} ${ep.handler}`.toLowerCase().includes(f));
  }

  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  if (args.formats.includes('json')) fs.writeFileSync(path.join(out, 'flowmap.json'), JSON.stringify(app, null, 2) + '\n');
  if (args.formats.includes('md')) {
    const dir = path.join(out, 'endpoints');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(out, 'index.md'), indexMarkdown(app));
    for (const ep of app.endpoints) fs.writeFileSync(path.join(dir, `${ep.id}.md`), endpointMarkdown(ep, { sourceUrl: args.sourceUrl }));
  }
  if (args.formats.includes('html')) fs.writeFileSync(path.join(out, 'index.html'), viewerHtml(app, args.mermaidUrl, args.serverUrl));
  if (args.formats.includes('openapi')) {
    const parts = openApiParts(app);
    fs.writeFileSync(path.join(out, 'openapi.json'), JSON.stringify(assembleOpenApi(parts, parts.operations, args.serverUrl), null, 2) + '\n');
  }

  const notes = app.endpoints.reduce((n, ep) => n + ep.warnings.length, 0) + app.warnings.length;
  process.stdout.write(
    `${sourceNote}, ${app.endpoints.length} entry points -> ${path.relative(process.cwd(), out) || '.'}` +
      (notes ? ` (${notes} analysis notes; see the "Analysis notes" sections)` : '') +
      '\n',
  );
  for (const w of app.warnings) process.stdout.write(`note: ${w}\n`);
  return app;
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`nest-flowmap: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
