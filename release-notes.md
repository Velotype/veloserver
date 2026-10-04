# Release notes

Changes in each version of `@velotype/veloserver` published to [JSR](https://jsr.io/@velotype/veloserver), newest first. Dates are JSR publish dates.

**Breaking** marks a change that can require updates to code that uses veloserver.

## Unreleased

- New `@velotype/veloserver/dev` entry point with `DevServer`, a development server for Velotype apps that updates the page when its files change. Its `mode` is `module` (serves each module unbundled and re-runs only the changed modules), `bundle` (rebuilds and re-runs the app bundle), `reload` (rebuilds the bundle and reloads the page), or `off` (writes the production scripts). In `module` and `bundle` mode, components on the page are updated in place and keep their state, using the Velotype dev runtime. `pageScripts()` writes the page's scripts for the current mode.

## 0.2.0 — 2026-09-22

- **Breaking:** `Server.serve()` no longer ends the process when the server finishes shutting down. It releases its signal listeners, so the process ends on its own when nothing else is pending. Pass `{exitProcessOnClose: true}` (the new `ServeOptions`) to end the process when the server stops.

## 0.1.5 — 2026-09-08

0.1.4 was not published, its changes are included here.

- Faster route matching, using a Map-based tree of path segments.
- `Context.url` is parsed on first use, and the request path is read without parsing the full URL.
- Memoized static files are also served gzip-compressed, to clients that accept it, when compression makes them smaller.
- Fix: a static path segment now takes priority over a path variable or wildcard at the same position.
- Fix: an error thrown by an async handler or inspector is converted to the server error response instead of being lost.
- Fix: `mountFiles()` now waits for its subdirectories to be mounted.

## 0.1.3 — 2026-07-06

- Fix: `Router.requestHandler` is bound to its router again, so that requests passed to it by `Server` are handled (broken since 0.1.0).

## 0.1.0 – 0.1.2 (yanked)

Published between 2026-02-17 and 2026-07-06. Requests to a `Server` failed in these versions, see 0.1.3.

- **0.1.2:** fix: `mountFile()` and `mountFiles()` served files memoized when `memoized` was `false`, and the other way around.
- **0.1.1:** **Breaking:** `RequestInspectorResponse` takes only an optional `response` (`shouldContinue` is removed): a request inspector stops a request by returning a response. New `mountFile()` to serve a single file.
- **0.1.0:** **Breaking:** `App` is renamed to `Server`, and `Router.jsonResponse()` is replaced by `json(request, context, data)`. New `badRequest()` and `serverError()` methods and a `bad_request_error_handler` Router option.

## 0.0.4 — 2026-01-04

0.0.3 was not published, its changes are included here.

- **Breaking:** the Router constructor takes an options object (`{not_found_handler, server_error_handler, context_metadata_constructor}`) instead of positional handlers.
- **Breaking:** `Router.jsonResponse()` is no longer static.
- New statically typed request metadata: `Context.meta`, typed by the `ContextMetadata` type parameter of `Router`, `App`, `Context`, `Handler`, and the inspector types, and created for each request by the `context_metadata_constructor` option.
- Routes and inspectors can be added to several paths at once by passing an array of paths.
- New `observeChildPaths` option for an `Inspector` (default: `true`), which sets whether it also runs for requests to paths below the one it was added to.

## 0.0.2 — 2025-09-03

- New `App.close()` to stop the server.

## 0.0.1 — 2025-08-25

- First release, moved from the `./webserver` entry point of `@velotype/velotype`: `App`, `Router` (GET, HEAD, and POST routes, path variables, wildcards, `mountFiles()` for static files), `Context`, and request and response inspectors. The `Mode` setting of the Velotype version is removed.
