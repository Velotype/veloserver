import { assertEquals, assertStringIncludes } from "@std/assert"
import { Router } from "../src/router.ts"

Deno.test("router.json() returns a JSON body with the expected content-type", async () => {
    const router: Router<never> = new Router<never>({})
    const res = await router.json(new Request("http://localhost/"), {} as never, { hello: "world" })
    assertEquals(res.status, 200)
    assertStringIncludes(res.headers.get("content-type") ?? "", "json")
    assertEquals(await res.text(), '{"hello":"world"}')
})

Deno.test("router.json() falls back to the server_error_handler when the data can't be stringified", async () => {
    const router: Router<never> = new Router<never>({
        server_error_handler: () => new Response("custom-500", { status: 500 }),
    })
    // deno-lint-ignore no-explicit-any
    const circular: any = {}
    circular.self = circular
    const res = await router.json(new Request("http://localhost/"), {} as never, circular)
    assertEquals(res.status, 500)
    assertEquals(await res.text(), "custom-500")
})

Deno.test("router.badRequest() and router.serverError() delegate to the configured handlers", async () => {
    const router: Router<never> = new Router<never>({
        bad_request_error_handler: () => new Response("custom-400", { status: 400 }),
        server_error_handler: () => new Response("custom-500", { status: 500 }),
    })
    const badReq = await router.badRequest(new Request("http://localhost/"), {} as never)
    assertEquals(badReq.status, 400)
    assertEquals(await badReq.text(), "custom-400")

    const serverErr = await router.serverError(new Request("http://localhost/"), {} as never)
    assertEquals(serverErr.status, 500)
    assertEquals(await serverErr.text(), "custom-500")
})

Deno.test("a custom not_found_handler passed to the constructor is used for unmatched routes", async () => {
    const router: Router<never> = new Router<never>({
        not_found_handler: () => new Response("nothing here", { status: 404, headers: { "x-custom-404": "yes" } }),
    })
    const res = await router.requestHandler(new Request("http://localhost/nope"))
    assertEquals(res.status, 404)
    assertEquals(res.headers.get("x-custom-404"), "yes")
    assertEquals(await res.text(), "nothing here")
})

Deno.test("a custom not_found_handler is also used for unsupported HTTP methods", async () => {
    const router: Router<never> = new Router<never>({
        not_found_handler: () => new Response("nothing here", { status: 404 }),
    })
    router.get("/x", () => new Response("ok", { status: 200 }))
    const res = await router.requestHandler(new Request("http://localhost/x", { method: "DELETE" }))
    assertEquals(res.status, 404)
    assertEquals(await res.text(), "nothing here")
})

Deno.test("a handler that throws synchronously is caught and converted via server_error_handler", async () => {
    const router: Router<never> = new Router<never>({
        server_error_handler: () => new Response("custom-500", { status: 500 }),
    })
    router.get("/boom", () => {
        throw new Error("sync boom")
    })
    const res = await router.requestHandler(new Request("http://localhost/boom"))
    assertEquals(res.status, 500)
    assertEquals(await res.text(), "custom-500")
})

Deno.test("an async handler that throws is also caught and converted via server_error_handler", async () => {
    const router: Router<never> = new Router<never>({
        server_error_handler: () => new Response("custom-500", { status: 500 }),
    })
    // deno-lint-ignore require-await
    router.get("/boom-async", async () => {
        throw new Error("async boom")
    })
    const res = await router.requestHandler(new Request("http://localhost/boom-async"))
    assertEquals(res.status, 500)
    assertEquals(await res.text(), "custom-500")
})

Deno.test("a handler that returns an already-rejected promise is also caught", async () => {
    const router: Router<never> = new Router<never>({
        server_error_handler: () => new Response("custom-500", { status: 500 }),
    })
    router.get("/boom-rejected", () => Promise.reject(new Error("rejected")))
    const res = await router.requestHandler(new Request("http://localhost/boom-rejected"))
    assertEquals(res.status, 500)
    assertEquals(await res.text(), "custom-500")
})

Deno.test("a request inspector that throws is caught by the same server_error_handler", async () => {
    const router: Router<never> = new Router<never>({
        server_error_handler: () => new Response("custom-500", { status: 500 }),
    })
    router.get("/x", () => new Response("ok", { status: 200 }))
    router.addGetInspector("/x", { requestInspector: () => { throw new Error("inspector boom") } } as never)
    const res = await router.requestHandler(new Request("http://localhost/x"))
    assertEquals(res.status, 500)
    assertEquals(await res.text(), "custom-500")
})

Deno.test("the default handlers (no overrides given) produce sensible built-in responses", async () => {
    const router: Router<never> = new Router<never>({})
    const notFound = await router.requestHandler(new Request("http://localhost/nope"))
    assertEquals(notFound.status, 404)

    const badRequest = await router.badRequest(new Request("http://localhost/"), {} as never)
    assertEquals(badRequest.status, 400)

    const serverError = await router.serverError(new Request("http://localhost/"), {} as never)
    assertEquals(serverError.status, 500)
})
