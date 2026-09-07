import { assertEquals } from "@std/assert"
import { Inspector, Router, RequestInspectorResponse } from "../src/router.ts"
import type { Context } from "@velotype/veloserver"

Deno.test("multiple inspectors on the same node run request-phase in order, then response-phase in order", async () => {
    const router: Router<never> = new Router<never>({})
    const order: string[] = []
    router.get("/x", () => {
        order.push("handler")
        return new Response("ok", { status: 200 })
    })
    router.addGetInspector("/x", new Inspector(
        (_req, _ctx) => { order.push("insp1-req"); return new RequestInspectorResponse() },
        (_req, _res, _ctx) => { order.push("insp1-res") },
    ))
    router.addGetInspector("/x", new Inspector(
        (_req, _ctx) => { order.push("insp2-req"); return new RequestInspectorResponse() },
        (_req, _res, _ctx) => { order.push("insp2-res") },
    ))

    await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(order, ["insp1-req", "insp2-req", "handler", "insp1-res", "insp2-res"])
})

Deno.test("a short-circuiting inspector skips its own response inspector and every later inspector", async () => {
    const router: Router<never> = new Router<never>({})
    const order: string[] = []
    router.get("/x", () => { order.push("handler"); return new Response("ok", { status: 200 }) })

    router.addGetInspector("/x", new Inspector(
        (_req, _ctx) => { order.push("insp1-req"); return new RequestInspectorResponse() },
        (_req, _res, _ctx) => { order.push("insp1-res") },
    ))
    router.addGetInspector("/x", new Inspector(
        (_req, _ctx) => { order.push("insp2-req"); return new RequestInspectorResponse(new Response("short-circuited", { status: 401 })) },
        (_req, _res, _ctx) => { order.push("insp2-res (must not run)") },
    ))
    router.addGetInspector("/x", new Inspector(
        (_req, _ctx) => { order.push("insp3-req (must not run)"); return new RequestInspectorResponse() },
    ))

    const res = await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(res.status, 401)
    assertEquals(await res.text(), "short-circuited")
    // insp1's response inspector still runs (it was queued before the short-circuit);
    // insp2's own response inspector and insp3's request inspector never fire.
    assertEquals(order, ["insp1-req", "insp2-req", "insp1-res"])
})

Deno.test("request and response inspectors can both be async and are properly awaited", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/x", () => new Response("ok", { status: 200 }))
    router.addGetInspector("/x", new Inspector(
        async (_req, _ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            return new RequestInspectorResponse()
        },
        async (_req, res, _ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            res.headers.set("x-async-inspector", "ran")
        },
    ))
    const res = await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(res.headers.get("x-async-inspector"), "ran")
})

Deno.test("addPostInspector only applies to POST, not GET, on the same path", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/x", () => new Response("get", { status: 200 }))
    router.post("/x", () => new Response("post", { status: 200 }))
    let postInspectorRan = false
    router.addPostInspector("/x", new Inspector((_req, _ctx) => {
        postInspectorRan = true
        return new RequestInspectorResponse()
    }))

    await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(postInspectorRan, false)

    await router.requestHandler(new Request("http://localhost/x", { method: "POST" }))
    assertEquals(postInspectorRan, true)
})

Deno.test("addHeadInspector only applies to HEAD", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/x", () => new Response("get", { status: 200 }))
    router.head("/x", () => new Response(null, { status: 200 }))
    let headInspectorRan = false
    router.addHeadInspector("/x", new Inspector((_req, _ctx) => {
        headInspectorRan = true
        return new RequestInspectorResponse()
    }))

    await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(headInspectorRan, false)
    await router.requestHandler(new Request("http://localhost/x", { method: "HEAD" }))
    assertEquals(headInspectorRan, true)
})

Deno.test("addAllInspector applies to GET, HEAD, and POST alike", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/x", () => new Response("get", { status: 200 }))
    router.head("/x", () => new Response(null, { status: 200 }))
    router.post("/x", () => new Response("post", { status: 200 }))
    const methodsSeen: string[] = []
    router.addAllInspector("/x", new Inspector((req, _ctx) => {
        methodsSeen.push(req.method)
        return new RequestInspectorResponse()
    }))

    await router.requestHandler(new Request("http://localhost/x"))
    await router.requestHandler(new Request("http://localhost/x", { method: "HEAD" }))
    await router.requestHandler(new Request("http://localhost/x", { method: "POST" }))
    assertEquals(methodsSeen, ["GET", "HEAD", "POST"])
})

Deno.test("an inspector registered on a deep ancestor observes a multi-level-deeper leaf", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/a/b/c/d", () => new Response("deep", { status: 200 }))
    let observed = false
    router.addGetInspector("/a", new Inspector((_req, _ctx) => {
        observed = true
        return new RequestInspectorResponse()
    }))
    const res = await router.requestHandler(new Request("http://localhost/a/b/c/d"))
    assertEquals(res.status, 200)
    assertEquals(observed, true)
})

Deno.test("an inspector's meta-typed context is visible to a later inspector and the handler", async () => {
    type Meta = { uid?: string }
    const router: Router<Meta> = new Router<Meta>({
        context_metadata_constructor: () => ({}),
    })
    router.addGetInspector("/x", new Inspector<Meta>((_req: Request, context: Context<Meta>) => {
        context.meta.uid = "user-123"
        return new RequestInspectorResponse()
    }))
    let seenInHandler: string | undefined
    router.get("/x", (_req: Request, context: Context<Meta>) => {
        seenInHandler = context.meta.uid
        return new Response("", { status: 200 })
    })
    await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(seenInHandler, "user-123")
})
