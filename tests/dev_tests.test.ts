import { assert, assertEquals } from "@std/assert"
import { Router } from "../src/router.ts"
import { DevServer } from "../src/dev/dev.ts"
import { findExports, findSpecifiers, isVelotypeSpecifier, rewriteSpecifiers } from "../src/dev/specifiers.ts"
import { ModuleGraph } from "../src/dev/module-graph.ts"
import { stripJsonComments, writeDevConfig } from "../src/dev/config.ts"

Deno.test("findSpecifiers finds static, side effect, re-export, and dynamic imports", () => {
    const code = `import { a } from "./a.ts"
import type { B } from './b.ts'
import "./style.ts"
export * from "jsr:@std/assert"
const lazy = await import("./lazy.tsx")
const text = "not an import"`
    assertEquals(findSpecifiers(code), ["./a.ts", "./b.ts", "./style.ts", "jsr:@std/assert", "./lazy.tsx"])
})

Deno.test("rewriteSpecifiers replaces each specifier and keeps its quotes", () => {
    const code = `import { a } from "./a.ts"\nimport 'b'\nimport("./c.ts")`
    assertEquals(rewriteSpecifiers(code, specifier => specifier.toUpperCase()), `import { a } from "./A.TS"\nimport 'B'\nimport("./C.TS")`)
})

Deno.test("isVelotypeSpecifier matches the Velotype package and its entry points", () => {
    for (const specifier of ["@velotype/velotype", "@velotype/velotype/jsx-dev-runtime", "jsr:@velotype/velotype@^0.2.3", "jsr:@velotype/velotype@0.2.3/jsx-runtime", "jsr:@velotype/velotype/devtools", "npm:@jsr/velotype__velotype@0.2.3"]) {
        assert(isVelotypeSpecifier(specifier), specifier)
    }
    for (const specifier of ["@velotype/veloserver", "@velotype/velotypes", "./velotype.ts"]) {
        assert(!isVelotypeSpecifier(specifier), specifier)
    }
    assert(isVelotypeSpecifier("vt/jsx-dev-runtime", "vt"))
})

Deno.test("findExports reads the export statements that deno bundle writes", () => {
    const code = `var Counter = class {};\nfunction label() {}\nexport {\n  Counter,\n  label as Label\n};\n`
    assertEquals([...findExports(code)], [["Counter", "Counter"], ["Label", "label"]])
    assertEquals([...findExports(`var x = 1;\nexport default x;\n`)], [["default", "x"]])
})

Deno.test("ModuleGraph stops an update at modules that accept it", () => {
    const graph = new ModuleGraph()
    graph.update("/main.tsx", ["/app.tsx"], false)
    graph.update("/app.tsx", ["/counter.tsx", "/util.ts"], true)
    graph.update("/counter.tsx", ["/util.ts"], true)
    graph.update("/util.ts", [], false)

    assertEquals(graph.propagate("/counter.tsx"), {reload: false, boundaries: ["/counter.tsx"], invalidated: ["/counter.tsx"]})
    // A change to a module that does not accept updates re-runs the modules that import it
    const util = graph.propagate("/util.ts")
    assert(!util.reload)
    assertEquals(util.boundaries.sort(), ["/app.tsx", "/counter.tsx"])
    assertEquals(util.invalidated.sort(), ["/app.tsx", "/counter.tsx", "/util.ts"])
    // A change that reaches the entry module reloads the page
    assertEquals(graph.propagate("/main.tsx"), {reload: true})

    graph.bump(["/util.ts"], 3)
    assertEquals(graph.version("/util.ts"), 3)
    assertEquals(graph.version("/app.tsx"), 0)
})

Deno.test("ModuleGraph.update replaces a module's imports", () => {
    const graph = new ModuleGraph()
    graph.update("/main.tsx", ["/a.tsx"], false)
    graph.update("/a.tsx", [], false)
    graph.update("/main.tsx", ["/b.tsx"], false)
    // /a.tsx is no longer imported, so a change to it reaches no entry module
    assertEquals(graph.propagate("/a.tsx"), {reload: true})
    assertEquals(graph.propagate("/b.tsx"), {reload: true})
})

Deno.test("DevServer in module mode serves transpiled modules with hot update code", async () => {
    const root = await Deno.makeTempDir()
    try {
        await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({compilerOptions: {jsx: "react-jsxdev", jsxImportSource: "@velotype/velotype"}}))
        await Deno.mkdir(`${root}/browser`)
        await Deno.writeTextFile(`${root}/browser/main.ts`, `import { Counter } from "./counter.ts"\nimport { assert } from "jsr:@std/assert@^1.0.19"\nassert(Counter)\n`)
        await Deno.writeTextFile(`${root}/browser/counter.ts`, `import { Component } from "@velotype/velotype"\nexport class Counter extends Component<Record<string, never>> {\n    override render() { return null }\n}\n`)

        const dev = new DevServer({mode: "module", entry: "./browser/main.ts", root})
        const router = new Router<never>({})
        await dev.mount(router)
        try {
            assertEquals(dev.pageScripts(), `<script type="module" src="/__velo/client.js"></script>\n<script type="module" src="/__velo/m/browser/main.ts"></script>`)

            const main = await (await router.requestHandler(new Request("http://localhost/__velo/m/browser/main.ts"))).text()
            assert(main.startsWith("import.meta.hot = "), "import.meta.hot is set first")
            assert(main.includes(`from "./counter.ts"`), "relative imports are kept")
            assert(main.includes(`/__velo/deps/${encodeURIComponent("jsr:@std/assert@^1.0.19")}.js`), "packages load from /__velo/deps/")

            const counter = await (await router.requestHandler(new Request("http://localhost/__velo/m/browser/counter.ts"))).text()
            assert(counter.includes(`from "/__velo/velotype.js"`), "Velotype loads the shared dev runtime")
            assert(counter.includes(`registerModule(import.meta.url, {"Counter": Counter})`), "component exports are registered")

            const outside = await router.requestHandler(new Request("http://localhost/__velo/m/..%2F..%2Fetc%2Fpasswd"))
            assertEquals(outside.status, 404)

            const client = await router.requestHandler(new Request("http://localhost/__velo/client.js"))
            assert((await client.text()).includes("__VELO_HMR__"))
        } finally {
            dev.close()
        }
    } finally {
        await Deno.remove(root, {recursive: true})
    }
})

Deno.test("DevServer in off mode writes the production scripts and adds no routes", async () => {
    const root = await Deno.makeTempDir()
    try {
        const dev = new DevServer({mode: "off", entry: "./browser/main.ts", root, production: {importMap: {"@velotype/velotype": "/build/velotype.min.mjs"}, scripts: ["/build/main.min.mjs"]}})
        const router = new Router<never>({})
        await dev.mount(router)
        assertEquals(dev.pageScripts(), `<script type="importmap">{"imports":{"@velotype/velotype":"/build/velotype.min.mjs"}}</script>\n<script type="module" src="/build/main.min.mjs"></script>`)
        assertEquals((await router.requestHandler(new Request("http://localhost/__velo/client.js"))).status, 404)
    } finally {
        await Deno.remove(root, {recursive: true})
    }
})

Deno.test("stripJsonComments removes comments and trailing commas outside of strings", () => {
    const text = `{
    // a comment
    "url": "https://example.com/a", /* block */
    "list": [1, 2,],
}`
    assertEquals(JSON.parse(stripJsonComments(text)), {url: "https://example.com/a", list: [1, 2]})
})

Deno.test("writeDevConfig sets the dev JSX transform and makes relative paths absolute", async () => {
    const dir = await Deno.makeTempDir()
    try {
        const project = {path: "/project/deno.json", json: {
            compilerOptions: {jsx: "react-jsx", jsxImportSource: "@velotype/velotype"},
            imports: {"@velotype/velotype": "jsr:@velotype/velotype@^0.2", "local/": "./src/", "up": "../shared/mod.ts"},
            tasks: {dev: "deno run dev.ts"},
        }}
        const json = JSON.parse(await Deno.readTextFile(writeDevConfig(project, dir)))
        assertEquals(json.compilerOptions, {jsx: "react-jsxdev", jsxImportSource: "@velotype/velotype"})
        assertEquals(json.imports, {"@velotype/velotype": "jsr:@velotype/velotype@^0.2", "local/": "file:///project/src/", "up": "file:///shared/mod.ts"})
        assertEquals(json.lock, "/project/deno.lock")
        assertEquals(json.tasks, undefined)
    } finally {
        await Deno.remove(dir, {recursive: true})
    }
})
