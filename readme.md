# veloserver

A web server framework for high-performance websites.

```ts
import { Router, Server } from "jsr:@velotype/veloserver"

const router = new Router<never>({})

router.get("/", () => {
    const response = new Response("<!DOCTYPE html><html><body>Hello veloserver!</body></html>")
    response.headers.set("content-type", "text/html; charset=utf-8")
    return response
})

const server = new Server(router)
server.serve("127.0.0.1", 3000)
```

Run it with `deno run --allow-net server.ts`.

## Routes

`get()`, `head()`, and `post()` add a handler for a path, or for several paths when given an array. A handler receives the request and its `Context`, and returns a `Response` (or a promise of one).

- `:name` matches one path segment and stores it as a path variable
- `*` at the end of a path matches any remaining segments

A static segment takes priority over a path variable or wildcard at the same position.

```ts
router.get("/users/:id", (_request, context) => {
    return router.json(_request, context, {id: context.pathVariables?.get("id")})
})
router.get(["/docs/*", "/guides/*"], () => new Response("documentation"))
```

`router.json()` returns a JSON response, and `router.badRequest()` and `router.serverError()` return the router's error responses. The Router options set the handlers for unmatched paths (`not_found_handler`), bad requests (`bad_request_error_handler`), and errors thrown by handlers (`server_error_handler`).

## Request metadata

`Context.meta` holds typed metadata for each request, created by the `context_metadata_constructor` option. Its type is the Router's type parameter.

```ts
type Metadata = {startTime: number}

const router = new Router<Metadata>({
    context_metadata_constructor: () => ({startTime: performance.now()}),
})
```

## Inspectors

An `Inspector` runs before and after the handlers of a path. Its request inspector can answer the request itself, by returning a `RequestInspectorResponse` with a response, and its response inspector sees each response. By default an inspector also runs for the paths below its own (`observeChildPaths`).

```ts
import { Inspector, RequestInspectorResponse, Router, Server } from "jsr:@velotype/veloserver"

type Metadata = {startTime?: number}
const router = new Router<Metadata>({context_metadata_constructor: () => ({})})

router.addAllInspector("", new Inspector<Metadata>(
    (_request, context) => {
        context.meta.startTime = performance.now()
        return new RequestInspectorResponse()
    },
    (request, response, context) => {
        console.log(`${response.status} ${request.method} ${request.url} ${(performance.now() - context.meta.startTime!).toFixed(1)}ms`)
    },
))
```

`addGetInspector()`, `addHeadInspector()`, and `addPostInspector()` add an inspector for one HTTP method.

## Static files

`mountFiles()` serves a directory, and `mountFile()` a single file. By default files are read once and held in memory, with an ETag and a gzip-compressed copy for clients that accept it. Pass `memoized: false` to read the file on each request.

```ts
await router.mountFiles("/build/", "./build/")
await router.mountFile("/favicon.ico", "./assets/favicon.ico")
```

## Shutting down

`serve()` registers listeners for `SIGINT`, `SIGTERM` and `SIGUSR1`, and releases them once the server has finished shutting down. With nothing else pending, the process then ends on its own. `server.close()` stops the server from code.

```ts
server.serve("127.0.0.1", 3000, {exitProcessOnClose: true})
```

Pass `exitProcessOnClose: true` to end the process the moment the server stops, even with other work still pending. `addServerListenCallback()` and `addServerFinishedCallback()` run code when the server starts listening and when it has finished.

## Development server

`@velotype/veloserver/dev` serves a Velotype app during development and updates the page when its files change.

```ts
import { Router, Server } from "jsr:@velotype/veloserver"
import { DevServer } from "jsr:@velotype/veloserver/dev"

const dev = new DevServer({mode: "module", entry: "./browser/main.tsx"})
const router = new Router<never>({})
await dev.mount(router)

router.get("/", () => new Response(`<!DOCTYPE html><html><body><div id="app"></div>${dev.pageScripts()}</body></html>`,
    {headers: {"content-type": "text/html; charset=utf-8"}}))

const server = new Server(router)
// Watching files keeps the process running, so stop it with the server
server.addServerFinishedCallback(() => dev.close())
server.serve("localhost", 3000)
```

Run it with `--allow-net --allow-read --allow-write --allow-run --allow-env`: builds run `deno bundle` and write temporary files.

`mode` sets how the page is updated when a file changes:

| Mode | Serves | On a change |
|---|---|---|
| `module` | each module unbundled, transpiled on request | re-runs the changed modules, the components on the page keep their state |
| `bundle` | the app bundle | rebuilds and re-runs the bundle, the components on the page keep their state |
| `reload` | the app bundle | rebuilds the bundle and reloads the page |
| `off` | the `production` scripts | nothing, no development routes are added |

`pageScripts()` writes the scripts for the current mode, so switching modes needs no change to the page. In `off` mode it writes the `production` option's import map and scripts.

Hot updates use the Velotype dev runtime (`@velotype/velotype/jsx-dev-runtime`), so builds use `"jsx": "react-jsxdev"` whatever deno.json sets, and the project's own setting can stay `react-jsx` for production builds. Every Velotype import loads one shared copy of the dev runtime, served at `/__velo/velotype.js`.

In `module` mode a changed module is updated on its own when all of its exports are components, or when it calls `import.meta.hot.accept()`. Otherwise the modules that import it run again, and the page reloads when the change reaches the entry module. `import.meta.hot.dispose(callback)` runs `callback(import.meta.hot.data)` before a module runs again, to release what it set up.

A build error is logged in the browser and the page keeps running the last working code. When the server restarts, the page reloads.

See [hot-reload-demo](https://github.com/Velotype/example-velotype-projects/tree/main/hot-reload-demo) for an app that runs in each mode.
