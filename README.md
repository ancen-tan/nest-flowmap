# nest-flowmap

Documentation for a NestJS API, generated from its source code. Point it at an app and it writes:

- **An offline viewer** (`index.html`) with every endpoint, its flowchart from request to response,
  a mindmap, and a details page: validation rules, guards, entities, and every response it can
  return.
- **An OpenAPI 3.0.0 document** (`openapi.json`) with paths, parameters, request schemas built from
  the DTOs and their class-validator rules, responses, and security.
- **Markdown pages** (`index.md`, `endpoints/*.md`) with Mermaid diagrams, for a wiki, GitLab or GitHub.
- **Postman, Bruno and OpenAPI downloads** from the viewer, for all endpoints or a filtered set.

It reads the TypeScript with ts-morph. It does not build, start or call the app, and it works
without the app's `node_modules`. No LLM is involved: the same source always gives the same
output, with no timestamps, so the output can be committed and diffed in review. Nothing is
uploaded. The viewer has Mermaid embedded and works offline.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Using the viewer](#using-the-viewer)
- [OpenAPI](#openapi)
- [Postman and Bruno](#postman-and-bruno)
- [Command-line options](#command-line-options)
- [Recipes](#recipes)
- [Output files](#output-files)
- [What is read for each layer](#what-is-read-for-each-layer)
- [Limits](#limits)
- [Development](#development)

## Install

You need Node.js 18 or newer. Install it from this folder or from a packed file.

### From this folder

```bash
cd nest-flowmap
npm install              # installs dependencies and builds dist/
npm install -g .         # puts the nest-flowmap command on your PATH
nest-flowmap --version
```

`npm install -g .` links the global command to this folder, so a `git pull` followed by
`npm install` (or `npm run build`) updates the command in place. Keep the folder where it is.

### From a package file (to share with the team)

```bash
cd nest-flowmap
npm install
npm pack                 # writes nest-flowmap-<version>.tgz
```

Send the `.tgz` file to a teammate, who runs:

```bash
npm install -g ./nest-flowmap-0.1.0.tgz
nest-flowmap --version
```

This makes a standalone copy; the original folder is not needed afterwards. To update, install
a newer `.tgz` the same way.

### From a Git repository

If the folder is pushed to a Git host, it can be installed straight from there; npm builds it during
install:

```bash
npm install -g git+ssh://git@bitbucket.org/<workspace>/nest-flowmap.git
```

### Uninstall

```bash
npm uninstall -g nest-flowmap
```

## Quick start

```bash
nest-flowmap ~/projects/my-nest-app --out docs/api
open docs/api/index.html            # macOS; or open the file in any browser
```

Output looks like this:

```
852 source files, 178 entry points -> docs/api (221 analysis notes; see the "Analysis notes" sections)
```

`docs/api` now contains `index.html`, `openapi.json`, `flowmap.json`, `index.md` and
`endpoints/`. Analysis notes are places where the tool could not follow the code, for example a
provider created at runtime. Each endpoint lists its own notes.

Run it from anywhere. The project directory defaults to the current directory, and the output
directory defaults to `./flowmap`.

## Using the viewer

Open `index.html` in a browser. It is one file, so it can be emailed, attached to a ticket, or
served from any static host.

### Finding an endpoint

The sidebar lists every endpoint grouped by controller, followed by queue processors, event
listeners, cron jobs and message handlers. Type in **Filter** to narrow it by method, path or
handler name, for example `POST /v1/user` or `TransferController`. The page address keeps the
selected endpoint (`index.html#POST-v1-user`), so links to a specific endpoint can be shared.

### Flowchart

The flowchart follows a request from the route through middleware, guards, interceptors, pipes and
validation into the controller and the services it calls, down to database and external calls, and
out to each response. Colours mark the layer, as shown in the legend. Diamonds are decisions,
cylinders are database access, slanted boxes are external or async calls, and dashed lines are
error paths.

Large endpoints open folded so they stay readable:

- A box marked **"▸ N more steps"** is a call whose body is folded. Click it to expand it.
  Click an expanded call to fold it again.
- When an endpoint opens, its handler is expanded, and further calls are expanded level by level
  while the chart stays within about 50 boxes. Small endpoints show in full.
- Errors raised inside folded calls are merged per status, e.g. **"422 Unprocessable Entity · 8
  reasons"**. Expand the call to see where each one comes from, or open **Details** for the full list.
- **Expand all** draws every step, which can take a few seconds on the largest endpoints.
  **Collapse all** folds back to the handler level.
- **Lines** switches between right-angle (default), straight and curved connectors.
- **Group by layer** puts the boxes into one lane per layer.
- **−**, **+**, **Fit width** and **100%** zoom; drag the chart to pan.
- **Copy Mermaid** copies the chart as currently shown, for pasting into a wiki or a Mermaid editor.

### Mindmap and Details

**Mindmap** gives a one-screen summary of an endpoint: validation, middleware, the calls it
makes, entities and responses. **Overview** at the top of the sidebar shows every endpoint in one
mindmap.

**Details** has the tables:

- the pipeline in execution order;
- every validated field, with its type, whether it is required, and its rules;
- the entities touched, with columns, relations and hooks;
- every response with its status, the condition that triggers it, and the source line;
- analysis notes.

### Light and dark

**Dark / light** switches the theme. By default the viewer follows the operating system setting.

### Export API

The **Export API** panel at the bottom of the sidebar downloads the endpoints in three formats.
Set **Base URL** to the server you want the requests to target, then click:

| Button | File | Import into |
| --- | --- | --- |
| **Postman** | `<app>.postman_collection.json` | Postman: *Import*, pick the file |
| **Bruno** | `<app>.bruno.json` | Bruno: *Import Collection* → *Bruno Collection*, pick the file |
| **OpenAPI** | `<app>.openapi.json` | Swagger UI, Redoc, Stoplight, Insomnia, Postman, Bruno, or a code generator |

If the sidebar is filtered, only the matching HTTP endpoints are exported. The line under the buttons
says how many will be included. The viewer remembers the base URL.

## OpenAPI

Every run writes `openapi.json` next to `index.html`. It covers all HTTP endpoints and uses the
server URL from `--server-url` (default `http://localhost:3000`). The **OpenAPI** button in the
viewer produces the same document for a filtered set of endpoints and the base URL you typed.

To browse it as interactive docs:

```bash
npx @redocly/cli build-docs docs/api/openapi.json -o docs/api/redoc.html   # one HTML page
# or Swagger UI at http://localhost:8080
docker run -p 8080:8080 -e SWAGGER_JSON=/spec/openapi.json -v "$PWD/docs/api:/spec" swaggerapi/swagger-ui
```

Postman and Bruno can also import `openapi.json` directly.

### What goes into the document

| Part | Source |
| --- | --- |
| `paths` | Routes with the global prefix and version; `:id` becomes `{id}` |
| Path parameters | Path segments; types from `ParseIntPipe`, `ParseUUIDPipe` and the like, or from a `@Param()` DTO |
| Query parameters | Fields of the `@Query()` DTO, or keyed `@Query('x')` |
| Header parameters | Keyed `@Headers('x')` |
| `requestBody` | The `@Body()` DTO as a schema under `components.schemas`; nested DTOs get their own schema; `@UploadedFile()` becomes `multipart/form-data` |
| Schema rules | `IsString`, `IsInt`, `IsNumber`, `IsBoolean`, `IsDate*` → `type` / `format`; `IsEmail` → `email`; `IsUUID` → `uuid`; `IsUrl` → `uri`; `IsEnum` and `IsIn` → `enum`; `Min` / `Max` → `minimum` / `maximum`; `Length`, `MinLength`, `MaxLength` → string lengths; `Matches` → `pattern`; `ArrayMinSize` / `ArrayMaxSize` → array sizes; `@IsOptional()` → not `required`. All rules are also listed in the field's `description` |
| `responses` | One entry per status the analysis found, with every reason as the description (for example `UserExistsException: User with email ... already exists`). The success response has a schema when the return type's fields are known |
| `security` | Guards named `*Basic*` → `basicAuth`; `*Jwt*` / `*Bearer*` → `bearerAuth` |
| `tags` | One per controller |
| `operationId` | `Controller_method`, made unique |
| `description` | Handler and source line, pipeline, validation summary, responses and analysis notes |
| `info.version` | `version` from the app's `package.json` |

Responses whose status cannot be determined statically, such as rethrown errors, are listed under
`default`. An enum declared outside the project shows as a string with the TypeScript type in its
description.

## Postman and Bruno

Each exported request has:

- the URL as `{{baseUrl}}/path/:param`, with path variables, query parameters from the query DTO
  (optional ones disabled) and keyed `@Headers('x')` headers;
- a JSON body built from the body DTO. `IsIn` and `IsEnum` give the first allowed value. `IsEmail`,
  `IsUUID`, date and phone rules give a matching sample, and `Min` gives the minimum. Anything else
  is left empty, or shown as `<TypeName>` when the type is not known. Optional fields are included,
  so remove the ones you do not send;
- auth guessed from guard names: `*Basic*` guards use basic auth with `{{username}}` and `{{password}}`;
  `*Jwt*` and `*Bearer*` guards use a bearer `{{token}}`. Auth done anywhere else (session cookies,
  API-key middleware, library guards with other names) is not set, but the pipeline is listed in
  each request's docs;
- docs with the handler, pipeline, validation rules and every response the analysis found.

Collections come with a `baseUrl` variable plus `token`, or `username` and `password`, as needed.
In Bruno these are in a `local` environment, with the credentials marked secret.

## Command-line options

```
nest-flowmap [project-dir] [options]
```

| Option | Meaning |
| --- | --- |
| `--out <dir>` | Output directory (default `flowmap`) |
| `--tsconfig <file>` | tsconfig to load (default `tsconfig.json` in the project directory) |
| `--filter <text>` | Only entry points whose `METHOD /path` or handler contains the text, e.g. `--filter "POST /v1/user"` |
| `--depth <n>` | How many nested calls to follow from a handler (default 6) |
| `--format <list>` | Any of `html,md,json,openapi` (default all four) |
| `--server-url <url>` | Server URL in `openapi.json` and the viewer's default base URL (default `http://localhost:3000`) |
| `--name <text>` | Title in the output (default the `name` in the app's `package.json`) |
| `--source-url <tpl>` | Turn source references in the Markdown into links, e.g. `https://bitbucket.org/team/app/src/main/{path}#lines-{line}` |
| `--mermaid-url <url>` | Load Mermaid from a URL instead of embedding it (smaller HTML, needs network) |
| `--from-json <file>` | Render from a saved `flowmap.json` instead of reading source, e.g. to rebuild the viewer with a newer version of this tool |
| `--verbose` | Also draw plain statements, not only branches, calls and database access |
| `-v`, `--version` | Show the installed version |
| `-h`, `--help` | Show help |

## Recipes

**Only the OpenAPI document**

```bash
nest-flowmap ~/projects/my-nest-app --out docs/api --format openapi --server-url https://api.staging.example.com
```

**One part of the API**

```bash
nest-flowmap . --filter "/v1/transfer" --out docs/transfer
```

**A monorepo app**

```bash
nest-flowmap apps/payments --tsconfig apps/payments/tsconfig.app.json --out docs/payments
```

**Deeper or shallower flowcharts**

`--depth` limits how far calls are followed. Lower it for a quick overview of a large codebase, or
raise it if the notes say calls stopped at the depth limit.

**Keep the docs in the repository**

The output has no timestamps, so regenerating it only changes what changed in the code. Add a
script to the app's `package.json`:

```json
{
  "scripts": {
    "docs:api": "nest-flowmap . --out docs/api --server-url https://api.example.com"
  }
}
```

Run `npm run docs:api` before opening a pull request. Reviewers then see the flow and contract
changes next to the code.

**Generate docs in CI**

```bash
npm install -g ./tools/nest-flowmap-0.1.0.tgz
nest-flowmap . --out public/api-docs
```

Publish `public/api-docs` as a static site or a pipeline artifact.

## Output files

| File | Content |
| --- | --- |
| `index.html` | The viewer: endpoint list, flowcharts, mindmaps, details, exports. Self-contained and works offline |
| `openapi.json` | OpenAPI 3.0.0 document for the HTTP endpoints |
| `index.md`, `endpoints/*.md` | Markdown with Mermaid blocks, for GitLab, GitHub or a wiki that renders Mermaid. Flowcharts are drawn in full |
| `flowmap.json` | The full model (endpoints, steps, graph nodes and edges, responses) for other tooling |

## What is read for each layer

| Layer | Source |
| --- | --- |
| Endpoint | `@Controller`, `@Get/@Post/...`, `@Version`, `setGlobalPrefix`, `enableVersioning` |
| Validation | class-validator decorators on the DTO of `@Body/@Query/@Param/@Headers`; required unless `@IsOptional`; nested DTOs; `PartialType/PickType/OmitType/IntersectionType`; enum values for `@IsEnum`; parameter pipes such as `ParseUUIDPipe`; whether a `ValidationPipe` is active |
| Middleware | `app.use(...)`, `consumer.apply(...).forRoutes(...)`, global / controller / route guards, interceptors, pipes and filters, including `APP_GUARD`-style providers. The body of `canActivate()` and of middleware `use()` is drawn. Passport `AuthGuard('x')` is linked to its strategy's `validate()` |
| Controller and service | `if`, `switch`, loops, `try/catch`, `throw`, `return`, and calls into injected classes, followed recursively. Interfaces are followed when exactly one class implements them |
| Entity | TypeORM repository, entity manager, data source, query runner and query builder calls; transactions; `@BeforeInsert`-style hooks on `save/remove/softRemove/recover/find`; columns, constraints and relations in the details |
| External and async | BullMQ / Bull `queue.add` (linked to its `@Processor`), `EventEmitter2.emit` (linked to `@OnEvent` listeners), `HttpService`, `fetch`, microservice clients, and any injected dependency whose type is outside the project |
| Response | `@HttpCode` or the verb default, every reachable `throw` with status and message, guard and validation failures, `res.status().json()`, the return type, and Swagger `@Api*Response` declarations compared with what the code does |

Queue processors, `@OnEvent` listeners, `@Cron` jobs and `@MessagePattern` handlers get their own
flowcharts, listed after the HTTP endpoints. They are not part of the OpenAPI, Postman or Bruno
output.

## Limits

This is a static reading of the source, so some things are approximations. Each endpoint lists its
own "Analysis notes" where the tool could not follow something.

- Anything wired at runtime is invisible: dynamic modules, `useFactory` providers, string-token
  injection without a typed interface, handlers looked up from a map.
- Values are not tracked. A branch is drawn with its condition text, not evaluated.
- Guards with no `canActivate` in the project (library guards) are drawn as a box that passes or rejects.
- Interceptors are listed in order but their bodies are not drawn.
- `try/catch` is drawn with one error edge from the first database or external call in the block.
- TypeORM hooks are shown only for instance operations (`save`, `remove`, `softRemove`, `recover`, finds).
  Subscribers are listed in the details, not drawn.
- A method called twice in one endpoint is expanded the first time only.
- Database triggers, raw SQL contents and other services reached over the network end at one node.
- Auth in the OpenAPI, Postman and Bruno output is inferred from guard names. Session cookies,
  API keys checked in middleware, and guards with other names are not described.
- Response bodies are described only when the handler's return type lists its fields; error
  bodies follow your exception filter and are not described.
- A small share of mindmaps (2 of roughly 500 in testing) hit a layout bug in Mermaid 11. The viewer
  retries automatically; a Markdown renderer may show an error for that one diagram. Flowcharts are
  not affected.

## Development

```bash
npm install          # dependencies, then builds dist/
npm test             # builds, then runs the tests
```

| Path | Content |
| --- | --- |
| `src/cli.ts` | Command line |
| `src/project.ts` | Loads the TypeScript project with ts-morph |
| `src/analyze/` | Routes, app configuration, validation, entities, and the flow walker |
| `src/render/graph.ts` | Turns analysed steps into a graph of nodes and edges |
| `src/render/mermaid.ts` | Flowchart and mindmap source, folding, colour palettes |
| `src/render/openapi.ts` | OpenAPI 3.0.0 document |
| `src/render/collections.ts` | Postman and Bruno collections |
| `src/render/html.ts`, `assets/viewer.html` | The viewer |
| `src/render/markdown.ts` | Markdown output |
| `test/fixtures/` | NestJS code the tests run against |

Functions that the viewer also runs (`flowchart`, `collapseGraph`, `defaultExpanded`,
`assembleCollection` and `assembleOpenApi`) are copied into the page from their compiled source. They
must not use anything outside their own body. A test checks that the copies in the page behave the
same as in Node.
