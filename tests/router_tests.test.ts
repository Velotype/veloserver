import { assertEquals } from "@std/assert"
import { Inspector, Router } from "../src/router.ts"
import { RequestInspectorResponse } from "@velotype/veloserver"
import type {Context} from "@velotype/veloserver"

Deno.test("GET", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/", function() {
        const response = new Response("Hello Veloserver!",{status:200})
        return response
    })

    const req = new Request("http://localhost/")
    const res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(await res.text(), "Hello Veloserver!")
})

Deno.test("request inspector", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/", function() {
        const response = new Response("Hello Veloserver!",{status:200})
        return response
    })
    let inspectorTriggered = false
    router.addGetInspector("/",new Inspector((_request: Request, _context: Context) => {
        inspectorTriggered = true
        return new RequestInspectorResponse(true)
    }))

    const req = new Request("http://localhost/")
    await router.requestHandler(req)
    assertEquals(inspectorTriggered, true)
})

Deno.test("request inspector on leaf path", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/sub/path", function() {
        const response = new Response("",{status:200})
        return response
    })
    let inspectorTriggered = false
    router.addGetInspector("/sub/path",new Inspector((_request: Request, _context: Context) => {
        inspectorTriggered = true
        return new RequestInspectorResponse(true)
    }))

    const req = new Request("http://localhost/sub/path")
    const res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(inspectorTriggered, true)
})

Deno.test("request inspector on sub path", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/sub/path", function() {
        const response = new Response("",{status:200})
        return response
    })
    let inspectorTriggered = false
    router.addGetInspector("/sub",new Inspector((_request: Request, _context: Context) => {
        inspectorTriggered = true
        return new RequestInspectorResponse(true)
    }))

    const req = new Request("http://localhost/sub/path")
    const res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(inspectorTriggered, true)
})

Deno.test("request inspector on sub path, observeChildPaths false", async () => {
    const router: Router<never> = new Router<never>({})
    router.get(["/sub", "/sub/path"], function() {
        const response = new Response("",{status:200})
        return response
    })
    let inspectorTriggered = false
    router.addGetInspector("/sub",new Inspector((_request: Request, _context: Context) => {
        inspectorTriggered = true
        return new RequestInspectorResponse(true)
    }, undefined, false))

    let req = new Request("http://localhost/sub/path")
    let res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(inspectorTriggered, false)

    req = new Request("http://localhost/sub")
    res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(inspectorTriggered, true)
})

Deno.test("global request inspector", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/sub/path", function() {
        const response = new Response("",{status:200})
        return response
    })
    let inspectorTriggered = false
    router.addGetInspector("",new Inspector((_request: Request, _context: Context) => {
        inspectorTriggered = true
        return new RequestInspectorResponse(true)
    }))

    const req = new Request("http://localhost/sub/path")
    const res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(inspectorTriggered, true)
})

Deno.test("response inspector", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/", function() {
        const response = new Response("Hello Veloserver!",{status:200})
        return response
    })
    let inspectorTriggered = false
    router.addGetInspector("/",new Inspector(undefined, (_request: Request, _response: Response, _context: Context) => {
        inspectorTriggered = true
    }))

    const req = new Request("http://localhost/")
    await router.requestHandler(req)
    assertEquals(inspectorTriggered, true)
})

Deno.test("return 404 for unknown paths", async () => {
    const router: Router<never> = new Router<never>({})
    const req = new Request("http://localhost/unknown")
    const res = await router.requestHandler(req)
    assertEquals(res.status, 404)
})

Deno.test("POST", async () => {
    const router: Router<never> = new Router<never>({})
    router.post("/", async function(request: Request) {
        const response = new Response(await request.text() + " pong",{status:200})
        return response
    })

    const req = new Request("http://localhost/", {
        method: "POST",
        body: 'ping'
    })
    const res = await router.requestHandler(req)
    assertEquals(res.status, 200)
    assertEquals(await res.text(), "ping pong")
})

Deno.test("return 404 for unknown http methods", async () => {
    const router: Router<never> = new Router<never>({})
    router.get("/", function() {
        const response = new Response("Hello Veloserver!",{status:200})
        return response
    })

    const req = new Request("http://localhost/", {
        method: "POST",
        body: '{}'
    })
    const res = await router.requestHandler(req)
    assertEquals(res.status, 404)
})

type CustomContext = {
    uid: string
}
Deno.test("custom context", async () => {
    const router: Router<CustomContext> = new Router<CustomContext>({
        context_metadata_constructor: function() {
            return {uid: "invalid"}
        }
    })
    let inspectorTriggered = false
    let detectedUid: string | undefined = undefined
    router.get("/", function(_request: Request, context: Context<CustomContext>) {
        const response = new Response("Hello Veloserver!",{status:200})
        detectedUid = context.meta.uid
        return response
    })
    // Mimics an inspector that resolves auth, then setting that on the context
    router.addGetInspector("/",new Inspector((_request: Request, context: Context<CustomContext>) => {
        context.meta.uid = "123"
        inspectorTriggered = true
        return new RequestInspectorResponse(true)
    }))

    const req = new Request("http://localhost/")
    await router.requestHandler(req)
    assertEquals(inspectorTriggered, true)
    assertEquals(detectedUid, "123")
})
