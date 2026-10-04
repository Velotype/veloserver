// A development server for Velotype apps: serves the app, watches its files, and sends updates to the browser

import type { Context } from "../context.ts"
import type { Router } from "../router.ts"
import { bundle, bundleReexports, type BuildResult, type BuildSettings } from "./build.ts"
import { clientScript } from "./client.ts"
import { readProjectConfig, writeDevConfig } from "./config.ts"
import { ModuleGraph } from "./module-graph.ts"
import { findExports, findSpecifiers, isRelativeSpecifier, isUrlSpecifier, isVelotypeSpecifier, rewriteSpecifiers } from "./specifiers.ts"

/**
 * How the development server updates the page when a file changes
 *
 * - `module`: serve each module unbundled and re-run only the changed modules, keeping component state
 * - `bundle`: rebuild the app bundle and re-run it, keeping component state
 * - `reload`: rebuild the app bundle and reload the page
 * - `off`: no development server, the page loads `production` scripts
 */
export type DevMode = "module" | "bundle" | "reload" | "off"

/** Options for {@link DevServer} */
export type DevServerOptions = {
    /** How the page is updated when a file changes */
    mode: DevMode
    /** The browser entry module, relative to root, such as `./browser/main.tsx` */
    entry: string
    /** The project directory, which contains deno.json (default: the current directory) */
    root?: string
    /**
     * The project's config file, relative to root (default: `deno.json` or `deno.jsonc`)
     *
     * Builds use a copy of it with `"jsx": "react-jsxdev"`, so the project's own setting can stay `react-jsx` for production builds
     */
    config?: string
    /** Directories to watch, relative to root (default: the entry module's directory) */
    watch?: string[]
    /**
     * The Velotype package specifier that the dev runtime is loaded from (default: `compilerOptions.jsxImportSource`
     * from deno.json, or `@velotype/velotype`)
     */
    velotype?: string
    /** The page scripts for mode `off` */
    production?: {
        /** An import map to write before the scripts */
        importMap?: Record<string, string>
        /** The module scripts to load */
        scripts: string[]
    }
}

/** The routes the development server adds, under this prefix */
const routePrefix = "/__velo/"
const velotypeUrl = routePrefix + "velotype.js"
const bundleUrl = routePrefix + "bundle.js"
const moduleUrlPrefix = routePrefix + "m/"
const dependencyUrlPrefix = routePrefix + "deps/"

/** File extensions of modules that are transpiled and watched */
const moduleExtension = /\.(tsx?|jsx?|mts|mjs)$/

/** A transpiled module, before its imports are rewritten */
type TranspiledModule = {code: string, exports: Map<string, string>}

/** Messages sent to the browser client */
type ClientMessage =
    | {type: "hello", id: string}
    | {type: "reload"}
    | {type: "error", message: string}
    | {type: "bundle", url: string}
    | {type: "modules", generation: number, boundaries: string[], invalidated: string[]}

function javascriptResponse(code: string): Response {
    return new Response(code, {headers: {"content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache"}})
}

/** A script that logs a build error in the browser */
function errorScript(error: string): string {
    return `console.error(${JSON.stringify("[veloserver] build failed\n" + error)})\n`
}

/** Join path parts with `/`, normalizing `.` and `..` */
function joinPath(...parts: string[]): string {
    const segments: string[] = []
    for (const segment of parts.join("/").split("/")) {
        if (segment === "..") {
            segments.pop()
        } else if (segment !== "." && segment !== "") {
            segments.push(segment)
        }
    }
    return "/" + segments.join("/")
}

/**
 * A development server for a Velotype app
 *
 * ```ts
 * const dev = new DevServer({mode: "module", entry: "./browser/main.tsx"})
 * await dev.mount(router)
 * router.get("/", () => new Response(`<html><body><div id="app"></div>${dev.pageScripts()}</body></html>`,
 *     {headers: {"content-type": "text/html; charset=utf-8"}}))
 * ```
 *
 * Needs `--allow-read`, `--allow-write` (for temporary build files), `--allow-run` (to run `deno bundle`),
 * and `--allow-env`. The app is built with `"jsx": "react-jsxdev"`, whatever deno.json sets, so that it uses
 * the Velotype dev runtime.
 *
 * Watching files keeps the process running, so close the development server when the server closes:
 * `server.addServerFinishedCallback(() => dev.close())`
 */
export class DevServer {
    readonly #options: DevServerOptions
    readonly #root: string
    readonly #settings: BuildSettings
    readonly #jsxImportSource?: string
    readonly #velotype: string
    /** Identifies this server process, so that the client reloads after a restart */
    readonly #id = crypto.randomUUID()
    readonly #graph = new ModuleGraph()
    readonly #modules = new Map<string, Promise<BuildResult & {module?: TranspiledModule}>>()
    readonly #dependencies = new Map<string, Promise<BuildResult>>()
    readonly #clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
    #velotypeBuild?: Promise<BuildResult>
    #bundleBuild?: BuildResult
    #generation = 0
    #watcher?: Deno.FsWatcher
    #heartbeat?: number
    /** Holds the config that builds use */
    #tempDir?: string
    /** File changes are handled one batch at a time */
    #changes = Promise.resolve()

    /** Create a development server, call {@link DevServer.mount} to start it */
    constructor(options: DevServerOptions) {
        this.#options = options
        this.#root = Deno.realPathSync(options.root || Deno.cwd())
        // Builds use a copy of the project's config with the dev JSX transform
        const project = readProjectConfig(this.#root, options.config)
        let config: string | undefined
        if (options.mode !== "off") {
            this.#tempDir = Deno.makeTempDirSync({prefix: "veloserver-dev-"})
            config = writeDevConfig(project, this.#tempDir)
        }
        const jsxImportSource: string | undefined = project && project.json.compilerOptions && project.json.compilerOptions.jsxImportSource
        this.#jsxImportSource = jsxImportSource
        this.#velotype = options.velotype || jsxImportSource || "@velotype/velotype"
        const externals = new Set([`${this.#velotype}*`, "@velotype/velotype*", "jsr:@velotype/velotype*", "npm:@jsr/velotype__velotype*"])
        if (jsxImportSource) {
            externals.add(`${jsxImportSource}*`)
        }
        this.#settings = {root: this.#root, config, externals: [...externals]}
    }

    /** How the page is updated when a file changes */
    get mode(): DevMode {
        return this.#options.mode
    }

    /** The scripts to write into the app's pages: the update client and the app, for the current mode */
    pageScripts(): string {
        const mode = this.#options.mode
        if (mode === "off") {
            const production = this.#options.production
            if (!production) {
                return ""
            }
            const importMap = production.importMap ? `<script type="importmap">${JSON.stringify({imports: production.importMap})}</script>\n` : ""
            return importMap + production.scripts.map(src => `<script type="module" src="${src}"></script>`).join("\n")
        }
        const app = mode === "module" ? moduleUrlPrefix + this.#relative(this.#entryFile) : bundleUrl
        return `<script type="module" src="${routePrefix}client.js"></script>\n<script type="module" src="${app}"></script>`
    }

    /** Add the development routes to router, build the app, and start watching its files */
    async mount<ContextMetadata>(router: Router<ContextMetadata>): Promise<void> {
        const mode = this.#options.mode
        if (mode === "off") {
            return
        }
        router.get(routePrefix + "client.js", () => javascriptResponse(clientScript))
        router.get(routePrefix + "events", () => this.#events())
        router.get(velotypeUrl, async () => {
            const result = await this.#velotypeRuntime()
            return javascriptResponse(result.code !== undefined ? result.code : errorScript(result.error))
        })
        if (mode === "module") {
            router.get(moduleUrlPrefix + "*", (_request: Request, context: Context<ContextMetadata>) => this.#serveModule(context.url.pathname))
            router.get(dependencyUrlPrefix + "*", (_request: Request, context: Context<ContextMetadata>) => this.#serveDependency(context.url.pathname))
        } else {
            router.get(bundleUrl, () => {
                const result = this.#bundleBuild
                if (!result) {
                    return javascriptResponse(errorScript("The app has not been built"))
                }
                return javascriptResponse(result.code !== undefined ? this.#rewriteBundle(result.code) : errorScript(result.error))
            })
            await this.#buildBundle()
        }
        this.#watch()
        console.log(`[dev] ${mode} mode, serving ${this.#options.entry}`)
    }

    /** Stop watching files and close the connections to browsers */
    close(): void {
        if (this.#tempDir) {
            Deno.removeSync(this.#tempDir, {recursive: true})
            this.#tempDir = undefined
        }
        this.#watcher?.close()
        this.#watcher = undefined
        if (this.#heartbeat !== undefined) {
            clearInterval(this.#heartbeat)
            this.#heartbeat = undefined
        }
        for (const client of this.#clients) {
            try {
                client.close()
            } catch {
                // Already closed
            }
        }
        this.#clients.clear()
    }

    get #entryFile(): string {
        return joinPath(this.#root, this.#options.entry)
    }

    /** A path relative to root, without a leading `/` */
    #relative(file: string): string {
        return file.slice(this.#root.length + 1)
    }

    // ------- Browser connections -------

    /** An event stream of updates for a browser */
    #events(): Response {
        let controller: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
            start: (streamController) => {
                controller = streamController
                this.#clients.add(controller)
                this.#sendTo(controller, {type: "hello", id: this.#id})
            },
            cancel: () => {
                this.#clients.delete(controller)
            },
        })
        if (this.#heartbeat === undefined) {
            // Keeps connections open through proxies that close idle ones
            this.#heartbeat = setInterval(() => {
                for (const client of this.#clients) {
                    this.#write(client, ": heartbeat\n\n")
                }
            }, 25000)
            // The heartbeat does not keep the process running on its own
            Deno.unrefTimer(this.#heartbeat)
        }
        return new Response(stream, {headers: {"content-type": "text/event-stream", "cache-control": "no-cache"}})
    }

    #write(client: ReadableStreamDefaultController<Uint8Array>, text: string): void {
        try {
            client.enqueue(new TextEncoder().encode(text))
        } catch {
            this.#clients.delete(client)
        }
    }

    #sendTo(client: ReadableStreamDefaultController<Uint8Array>, message: ClientMessage): void {
        this.#write(client, `data: ${JSON.stringify(message)}\n\n`)
    }

    #send(message: ClientMessage): void {
        for (const client of this.#clients) {
            this.#sendTo(client, message)
        }
    }

    // ------- Watching files -------

    #watch(): void {
        const directories = (this.#options.watch || [this.#options.entry.replace(/\/[^/]*$/, "") || "."]).map(dir => joinPath(this.#root, dir))
        const watcher = Deno.watchFs(directories, {recursive: true})
        this.#watcher = watcher
        let pending = new Set<string>()
        let timer: number | undefined
        ;(async () => {
            try {
                for await (const event of watcher) {
                    if (event.kind === "access") {
                        continue
                    }
                    for (const path of event.paths) {
                        if (moduleExtension.test(path)) {
                            pending.add(path)
                        }
                    }
                    if (pending.size > 0) {
                        // Editors write a file in several steps, so changes are collected for a moment
                        clearTimeout(timer)
                        timer = setTimeout(() => {
                            const changed = [...pending]
                            pending = new Set<string>()
                            this.#changes = this.#changes.then(() => this.#handleChanges(changed)).catch(error => console.error("[dev] update failed", error))
                        }, 50)
                    }
                }
            } catch (error) {
                if (this.#watcher) {
                    console.error("[dev] file watching stopped", error)
                }
            }
        })()
    }

    async #handleChanges(files: string[]): Promise<void> {
        const mode = this.#options.mode
        if (mode === "bundle" || mode === "reload") {
            const result = await this.#buildBundle()
            if (result.error !== undefined) {
                this.#send({type: "error", message: result.error})
            } else {
                this.#send(mode === "bundle" ? {type: "bundle", url: bundleUrl} : {type: "reload"})
            }
            return
        }
        await this.#handleModuleChanges(files)
    }

    // ------- Bundle and reload modes -------

    async #buildBundle(): Promise<BuildResult> {
        const started = performance.now()
        const result = await bundle(this.#settings, this.#entryFile)
        if (result.error !== undefined) {
            console.error(`[dev] build failed\n${result.error}`)
            // The last working build keeps being served
            if (!this.#bundleBuild || this.#bundleBuild.error !== undefined) {
                this.#bundleBuild = result
            }
        } else {
            this.#bundleBuild = result
            console.log(`[dev] built ${this.#options.entry} in ${Math.round(performance.now() - started)}ms`)
        }
        return result
    }

    /** The bundle, with its Velotype imports loading the shared dev runtime */
    #rewriteBundle(code: string): string {
        return rewriteSpecifiers(code, specifier => isVelotypeSpecifier(specifier, this.#jsxImportSource) ? velotypeUrl : specifier)
    }

    // ------- The Velotype dev runtime -------

    /** One bundle of the Velotype dev runtime (with the devtools entry point), shared by the app and its dependencies */
    #velotypeRuntime(): Promise<BuildResult> {
        if (!this.#velotypeBuild) {
            this.#velotypeBuild = (async () => {
                const settings = {...this.#settings, externals: []}
                const withDevtools = await bundleReexports(settings, [`${this.#velotype}/jsx-dev-runtime`, `${this.#velotype}/devtools`], false)
                if (withDevtools.code !== undefined) {
                    return withDevtools
                }
                return bundleReexports(settings, [`${this.#velotype}/jsx-dev-runtime`], false)
            })()
        }
        return this.#velotypeBuild
    }

    // ------- Module mode -------

    /** The file of a module URL, or undefined when it is outside root */
    #fileOf(pathname: string): string | undefined {
        const file = joinPath(this.#root, decodeURIComponent(pathname.slice(moduleUrlPrefix.length)))
        return file.startsWith(this.#root + "/") ? file : undefined
    }

    /** Transpile a module, recording its imports and if it accepts updates in the graph */
    #transpile(file: string): Promise<BuildResult & {module?: TranspiledModule}> {
        let result = this.#modules.get(file)
        if (!result) {
            result = (async () => {
                let source: string
                try {
                    source = await Deno.readTextFile(file)
                } catch {
                    return {error: `Cannot read ${this.#relative(file)}`}
                }
                const specifiers = findSpecifiers(source)
                const built = await bundle(this.#settings, file, specifiers)
                if (built.error !== undefined) {
                    return built
                }
                const exports = findExports(built.code)
                const names = [...exports.keys()]
                const accepts = /\bhot\??\.accept\(/.test(source) || (names.length > 0 && names.every(name => /^[A-Z]/.test(name)))
                const dir = file.replace(/\/[^/]*$/, "")
                const imports = specifiers.filter(isRelativeSpecifier).map(specifier => joinPath(dir, specifier)).filter(path => moduleExtension.test(path))
                this.#graph.update(file, imports, accepts)
                return {code: built.code, module: {code: built.code, exports}}
            })()
            this.#modules.set(file, result)
        }
        return result
    }

    async #serveModule(pathname: string): Promise<Response> {
        const file = this.#fileOf(pathname)
        if (!file) {
            return new Response("Not Found", {status: 404})
        }
        const result = await this.#transpile(file)
        if (result.error !== undefined || !result.module) {
            this.#modules.delete(file)
            return javascriptResponse(errorScript(result.error || "Transpile failed"))
        }
        const {code, exports} = result.module
        const dir = file.replace(/\/[^/]*$/, "")
        const rewritten = rewriteSpecifiers(code, specifier => {
            if (isVelotypeSpecifier(specifier, this.#jsxImportSource)) {
                return velotypeUrl
            }
            if (isRelativeSpecifier(specifier)) {
                // A module that re-ran is loaded from a new URL
                const version = this.#graph.version(joinPath(dir, specifier))
                return version > 0 ? `${specifier}?vt-hot=${version}` : specifier
            }
            if (isUrlSpecifier(specifier)) {
                return specifier
            }
            return dependencyUrlPrefix + encodeURIComponent(specifier) + ".js"
        })
        // import.meta.hot comes first, on the same line so that the source map lines stay correct
        const prologue = "import.meta.hot = globalThis.__VELO_HMR__ ? globalThis.__VELO_HMR__.context(import.meta.url) : undefined;"
        const registered = [...exports].map(([exported, local]) => `${JSON.stringify(exported)}: ${local}`).join(", ")
        const epilogue = registered ? `\n;globalThis.__VELOTYPE_HOT__ && globalThis.__VELOTYPE_HOT__.registerModule(import.meta.url, {${registered}});\n` : "\n"
        return javascriptResponse(prologue + rewritten + epilogue)
    }

    async #serveDependency(pathname: string): Promise<Response> {
        const specifier = decodeURIComponent(pathname.slice(dependencyUrlPrefix.length).replace(/\.js$/, ""))
        let result = this.#dependencies.get(specifier)
        if (!result) {
            result = (async () => {
                // A package without a default export fails to bundle with one
                const withDefault = await bundleReexports(this.#settings, [specifier], true)
                return withDefault.code !== undefined ? withDefault : bundleReexports(this.#settings, [specifier], false)
            })()
            this.#dependencies.set(specifier, result)
        }
        const built = await result
        if (built.error !== undefined) {
            this.#dependencies.delete(specifier)
            return javascriptResponse(errorScript(built.error))
        }
        return javascriptResponse(this.#rewriteBundle(built.code))
    }

    async #handleModuleChanges(files: string[]): Promise<void> {
        const changed = files.filter(file => this.#graph.has(file))
        if (changed.length === 0) {
            return
        }
        for (const file of changed) {
            this.#modules.delete(file)
            const result = await this.#transpile(file)
            if (result.error !== undefined) {
                this.#modules.delete(file)
                this.#send({type: "error", message: result.error})
                return
            }
        }
        const boundaries = new Set<string>()
        const invalidated = new Set<string>()
        for (const file of changed) {
            const propagation = this.#graph.propagate(file)
            if (propagation.reload) {
                console.log(`[dev] ${this.#relative(file)} changed, reloading`)
                this.#send({type: "reload"})
                return
            }
            propagation.boundaries.forEach(boundary => boundaries.add(boundary))
            propagation.invalidated.forEach(module => invalidated.add(module))
        }
        const generation = ++this.#generation
        this.#graph.bump([...invalidated], generation)
        const url = (file: string) => moduleUrlPrefix + this.#relative(file)
        console.log(`[dev] ${changed.map(file => this.#relative(file)).join(", ")} changed, updating ${[...boundaries].map(file => this.#relative(file)).join(", ")}`)
        this.#send({type: "modules", generation, boundaries: [...boundaries].map(url), invalidated: [...invalidated].map(url)})
    }
}
