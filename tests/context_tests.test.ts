import { assertEquals, assertThrows } from "@std/assert"
import { Context } from "../src/context.ts"

Deno.test("getPathParts splits a simple path on /", () => {
    const context = new Context(new Request("http://localhost/users/42"), undefined)
    assertEquals(context.getPathParts(), ["", "users", "42"])
})

Deno.test("getPathParts for the root path returns a single empty segment", () => {
    const context = new Context(new Request("http://localhost/"), undefined)
    assertEquals(context.getPathParts(), ["", ""])
})

Deno.test("getPathParts ignores the query string", () => {
    const context = new Context(new Request("http://localhost/search?q=hello&page=2"), undefined)
    assertEquals(context.getPathParts(), ["", "search"])
})

Deno.test("getPathParts is memoized - repeated calls return the same array reference", () => {
    const context = new Context(new Request("http://localhost/a/b"), undefined)
    const first = context.getPathParts()
    const second = context.getPathParts()
    assertEquals(first === second, true)
})

Deno.test("context.url exposes pathname, search params, and host", () => {
    const context = new Context(new Request("http://example.com:8080/a/b?x=1"), undefined)
    assertEquals(context.url.pathname, "/a/b")
    assertEquals(context.url.searchParams.get("x"), "1")
    assertEquals(context.url.hostname, "example.com")
    assertEquals(context.url.port, "8080")
})

Deno.test("context.url is lazy and cached - repeated access returns the same URL instance", () => {
    const context = new Context(new Request("http://localhost/a"), undefined)
    const first = context.url
    const second = context.url
    assertEquals(first === second, true)
})

Deno.test("addPathVariable creates the Map lazily and accumulates multiple entries", () => {
    const context = new Context(new Request("http://localhost/"), undefined)
    assertEquals(context.pathVariables, undefined)
    context.addPathVariable("id", "42")
    context.addPathVariable("tag", "featured")
    assertEquals(context.pathVariables?.get("id"), "42")
    assertEquals(context.pathVariables?.get("tag"), "featured")
    assertEquals(context.pathVariables?.size, 2)
})

Deno.test("addPathVariable overwrites a value registered under the same name", () => {
    const context = new Context(new Request("http://localhost/"), undefined)
    context.addPathVariable("id", "first")
    context.addPathVariable("id", "second")
    assertEquals(context.pathVariables?.get("id"), "second")
})

Deno.test("meta is passed straight through from the constructor and is mutable", () => {
    type Meta = { count: number }
    const context = new Context<Meta>(new Request("http://localhost/"), { count: 0 })
    assertEquals(context.meta.count, 0)
    context.meta.count = 5
    assertEquals(context.meta.count, 5)
})

Deno.test("a Request with no path at all resolves to a single root segment", () => {
    const context = new Context(new Request("http://localhost"), undefined)
    assertEquals(context.getPathParts(), ["", ""])
})

Deno.test("percent-encoded path segments are preserved verbatim, matching URL.pathname", () => {
    const raw = new Request("http://localhost/users/John%20Doe")
    const context = new Context(raw, undefined)
    assertEquals(context.getPathParts(), ["", "users", "John%20Doe"])
    assertEquals(context.getPathParts().join("/"), context.url.pathname)
})

Deno.test("dot-segments are already normalized by Request construction, so getPathParts sees the resolved path", () => {
    const raw = new Request("http://localhost/a/nested/../b")
    const context = new Context(raw, undefined)
    assertEquals(context.url.pathname, "/a/b")
    assertEquals(context.getPathParts(), ["", "a", "b"])
})

Deno.test("a request.url with no scheme separator throws rather than silently misrouting", () => {
    // A real Request always yields an absolute, schemed URL, so this can't happen in
    // practice - but Context's fast-path pathname extraction has an explicit guard for
    // it, and that guard should fail loudly rather than route against garbage input.
    assertThrows(() => {
        // deno-lint-ignore no-explicit-any
        const fakeRequest = { url: "not-a-url-at-all" } as any
        new Context(fakeRequest, undefined).getPathParts()
    }, Error, "Invalid url")
})
