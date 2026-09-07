import { assertEquals } from "@std/assert"
import { Router } from "../src/router.ts"
import type { Context } from "@velotype/veloserver"

Deno.test("HEAD routes are independent of GET routes", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/ping", () => new Response("get", { status: 200 }))
    router.head("/ping", () => new Response(null, { status: 200, headers: { "x-source": "head" } }))

    const getRes = await router.requestHandler(new Request("http://localhost/ping"))
    assertEquals(await getRes.text(), "get")

    const headRes = await router.requestHandler(new Request("http://localhost/ping", { method: "HEAD" }))
    assertEquals(headRes.status, 200)
    assertEquals(headRes.headers.get("x-source"), "head")
})

Deno.test("HEAD has no route even when GET does - returns 404, not the GET handler", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/only-get", () => new Response("get", { status: 200 }))
    const res = await router.requestHandler(new Request("http://localhost/only-get", { method: "HEAD" }))
    assertEquals(res.status, 404)
})

Deno.test("GET and POST on the same path are independent handlers", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/items", () => new Response("list", { status: 200 }))
    router.post("/items", async (request: Request) => new Response("created:" + (await request.text()), { status: 201 }))

    const listRes = await router.requestHandler(new Request("http://localhost/items"))
    assertEquals(await listRes.text(), "list")

    const createRes = await router.requestHandler(new Request("http://localhost/items", { method: "POST", body: "payload" }))
    assertEquals(createRes.status, 201)
    assertEquals(await createRes.text(), "created:payload")
})

Deno.test("registering an array of paths maps them all to the same handler", async () => {
    const router: Router<never> = new Router<never>({})
    router.get(["/a", "/b", "/c"], () => new Response("shared", { status: 200 }))

    for (const path of ["/a", "/b", "/c"]) {
        const res = await router.requestHandler(new Request("http://localhost" + path))
        assertEquals(await res.text(), "shared", `expected ${path} to hit the shared handler`)
    }
    const missRes = await router.requestHandler(new Request("http://localhost/d"))
    assertEquals(missRes.status, 404)
})

Deno.test("multiple path variables at different depths are all captured", async () => {
    const router: Router<never> = new Router<never>({})
    let captured: Record<string, string> = {}
    router.get("/orgs/:orgId/teams/:teamId/members/:memberId", (_request: Request, context: Context) => {
        captured = Object.fromEntries(context.pathVariables ?? new Map())
        return new Response("", { status: 200 })
    })
    const res = await router.requestHandler(new Request("http://localhost/orgs/acme/teams/eng/members/42"))
    assertEquals(res.status, 200)
    assertEquals(captured, { orgId: "acme", teamId: "eng", memberId: "42" })
})

Deno.test("a wildcard splat matches any remaining depth, including an empty tail", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/files/*", () => new Response("splat", { status: 200 }))

    for (const path of ["/files/a", "/files/a/b/c", "/files/"]) {
        const res = await router.requestHandler(new Request("http://localhost" + path))
        assertEquals(res.status, 200, `expected ${path} to match the splat`)
        assertEquals(await res.text(), "splat")
    }
    // no trailing slash at all means there's no segment for the splat to capture
    const noSlashRes = await router.requestHandler(new Request("http://localhost/files"))
    assertEquals(noSlashRes.status, 404)
})

Deno.test("a wildcard splat only matches under its own mount point, not siblings", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/files/*", () => new Response("splat", { status: 200 }))
    router.get("/other", () => new Response("other", { status: 200 }))

    const otherRes = await router.requestHandler(new Request("http://localhost/other"))
    assertEquals(await otherRes.text(), "other")
    const missRes = await router.requestHandler(new Request("http://localhost/nope"))
    assertEquals(missRes.status, 404)
})

Deno.test("a registered prefix with no handler of its own 404s, even though it's a valid trie node", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/a/b/c", () => new Response("leaf", { status: 200 }))
    // "/a" and "/a/b" are real nodes in the trie (ancestors of the registered leaf)
    // but were never given their own handler.
    const resA = await router.requestHandler(new Request("http://localhost/a"))
    assertEquals(resA.status, 404)
    const resAB = await router.requestHandler(new Request("http://localhost/a/b"))
    assertEquals(resAB.status, 404)
    const resLeaf = await router.requestHandler(new Request("http://localhost/a/b/c"))
    assertEquals(resLeaf.status, 200)
})

Deno.test("a trailing slash is a distinct route from the same path without one", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/users", () => new Response("no-slash", { status: 200 }))
    const noSlashRes = await router.requestHandler(new Request("http://localhost/users"))
    assertEquals(await noSlashRes.text(), "no-slash")
    const slashRes = await router.requestHandler(new Request("http://localhost/users/"))
    assertEquals(slashRes.status, 404)
})

Deno.test("query strings don't affect path matching and are available on context.url", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/search", (_request: Request, context: Context) => {
        return new Response(context.url.searchParams.get("q") ?? "", { status: 200 })
    })
    const res = await router.requestHandler(new Request("http://localhost/search?q=veloserver&page=2"))
    assertEquals(res.status, 200)
    assertEquals(await res.text(), "veloserver")
})
