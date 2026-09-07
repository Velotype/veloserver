import { assertEquals } from "@std/assert"
import { Inspector, Router } from "../src/router.ts"
import { RequestInspectorResponse } from "@velotype/veloserver"
import type { Context } from "@velotype/veloserver"

// --- getPathParts() must not be corrupted by the router's own traversal ---

Deno.test("getPathParts returns the full path after routing has consumed it", async () => {
    const router: Router<never> = new Router<never>({})
    let capturedParts: string[] | undefined
    router.get("/users/:id/posts", function (_request: Request, context: Context) {
        capturedParts = context.getPathParts()
        return new Response("", { status: 200 })
    })
    const req = new Request("http://localhost/users/5/posts")
    const res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(capturedParts, ["", "users", "5", "posts"])
})

Deno.test("getPathParts is identical whether read by an inspector mid-route or the handler at the leaf", async () => {
    const router: Router<never> = new Router<never>({})
    const seen: string[][] = []
    router.addGetInspector("/users", new Inspector((_request: Request, context: Context) => {
        seen.push(context.getPathParts().slice())
        return new RequestInspectorResponse()
    }))
    router.get("/users/:id", function (_request: Request, context: Context) {
        seen.push(context.getPathParts().slice())
        return new Response("", { status: 200 })
    })
    const req = new Request("http://localhost/users/42")
    await router.requestHandler(req)
    assertEquals(seen, [
        ["", "users", "42"],
        ["", "users", "42"],
    ])
})

// --- static children must take priority over a path-variable sibling, regardless of Map/array split ---

Deno.test("a static sibling wins over a path-variable sibling at the same node", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/users/:id", function () { return new Response("param", { status: 200 }) })
    router.get("/users/active", function () { return new Response("static", { status: 200 }) })

    const paramRes = await router.requestHandler(new Request("http://localhost/users/42"))
    assertEquals(await paramRes.text(), "param")

    const staticRes = await router.requestHandler(new Request("http://localhost/users/active"))
    assertEquals(await staticRes.text(), "static")
})

// --- the fast-path pathname extraction must fall back to full URL parsing for anything it can't safely handle ---

Deno.test("dot-segments in the path are normalized the same as new URL()", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/public/file.txt", function () { return new Response("ok", { status: 200 }) })
    const res = await router.requestHandler(new Request("http://localhost/public/nested/../file.txt"))
    assertEquals(res.status, 200)
    assertEquals(await res.text(), "ok")
})

Deno.test("percent-encoded path segments still match, preserved verbatim like URL.pathname", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/users/:name", function (_request: Request, context: Context) {
        return new Response(context.pathVariables?.get("name"), { status: 200 })
    })
    const res = await router.requestHandler(new Request("http://localhost/users/John%20Doe"))
    assertEquals(res.status, 200)
    assertEquals(await res.text(), "John%20Doe")
})

Deno.test("root path still matches with the fast path", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/", function () { return new Response("home", { status: 200 }) })
    const res = await router.requestHandler(new Request("http://localhost/"))
    assertEquals(await res.text(), "home")
})

// --- context.url stays correct and lazy ---

Deno.test("context.url is parsed correctly and cached across repeated access", async () => {
    const router: Router<never> = new Router<never>({})
    let capturedQuery: string | null = null
    let sameReference = false
    router.get("/search", function (_request: Request, context: Context) {
        const first = context.url
        const second = context.url
        sameReference = first === second
        capturedQuery = context.url.searchParams.get("q")
        return new Response("", { status: 200 })
    })
    await router.requestHandler(new Request("http://localhost/search?q=hello"))
    assertEquals(capturedQuery, "hello")
    assertEquals(sameReference, true)
})

// --- mountFiles: recursion must actually be awaited, and gzip negotiation must round-trip ---

Deno.test("mountFiles awaits nested directories and negotiates gzip", async () => {
    const tmpDir = await Deno.makeTempDir()
    try {
        await Deno.mkdir(`${tmpDir}/sub`)
        const content = "hello velo ".repeat(200)
        await Deno.writeTextFile(`${tmpDir}/sub/greeting.txt`, content)

        const router: Router<never> = new Router<never>({})
        // If the recursive call inside mountFiles() weren't awaited, this outer await
        // could resolve before the nested route below was registered.
        await router.mountFiles("/static/", `${tmpDir}/`)

        const plainRes = await router.requestHandler(new Request("http://localhost/static/sub/greeting.txt"))
        assertEquals(plainRes.status, 200)
        assertEquals(await plainRes.text(), content)
        assertEquals(plainRes.headers.get("content-encoding"), null)

        const gzipRes = await router.requestHandler(new Request("http://localhost/static/sub/greeting.txt", {
            headers: { "accept-encoding": "gzip" },
        }))
        assertEquals(gzipRes.status, 200)
        assertEquals(gzipRes.headers.get("content-encoding"), "gzip")
        assertEquals(gzipRes.headers.get("etag")?.endsWith("-gzip"), true)
        const decompressed = await new Response(
            gzipRes.body?.pipeThrough(new DecompressionStream("gzip")),
        ).text()
        assertEquals(decompressed, content)
    } finally {
        await Deno.remove(tmpDir, { recursive: true })
    }
})
