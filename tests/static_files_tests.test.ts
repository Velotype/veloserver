import { assertEquals, assertRejects } from "@std/assert"
import { Router } from "../src/router.ts"

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await Deno.makeTempDir()
    try {
        await fn(dir)
    } finally {
        await Deno.remove(dir, { recursive: true })
    }
}

Deno.test("mountFile (memoized) serves a file's content with the right content-type", async () => {
    await withTempDir(async (dir) => {
        await Deno.writeTextFile(`${dir}/hello.txt`, "hello veloserver")
        const router: Router<never> = new Router<never>({})
        await router.mountFile("/hello", `${dir}/hello.txt`)

        const res = await router.requestHandler(new Request("http://localhost/hello"))
        assertEquals(res.status, 200)
        assertEquals(await res.text(), "hello veloserver")
        assertEquals(res.headers.get("content-type"), "text/plain; charset=UTF-8")
    })
})

Deno.test("mountFile (memoized) sets an ETag and returns 304 when if-none-match matches it", async () => {
    await withTempDir(async (dir) => {
        await Deno.writeTextFile(`${dir}/hello.txt`, "hello veloserver")
        const router: Router<never> = new Router<never>({})
        await router.mountFile("/hello", `${dir}/hello.txt`)

        const first = await router.requestHandler(new Request("http://localhost/hello"))
        const etag = first.headers.get("etag")
        assertEquals(typeof etag, "string")

        const second = await router.requestHandler(new Request("http://localhost/hello", {
            headers: { "if-none-match": etag! },
        }))
        assertEquals(second.status, 304)
        assertEquals(await second.text(), "")
    })
})

Deno.test("mountFile (memoized) keeps serving the original content even if the file changes on disk afterward", async () => {
    await withTempDir(async (dir) => {
        await Deno.writeTextFile(`${dir}/hello.txt`, "version one")
        const router: Router<never> = new Router<never>({})
        await router.mountFile("/hello", `${dir}/hello.txt`)

        await Deno.writeTextFile(`${dir}/hello.txt`, "version two - should not be seen")

        const res = await router.requestHandler(new Request("http://localhost/hello"))
        assertEquals(await res.text(), "version one")
    })
})

Deno.test("mountFile (memoized=false) re-reads the file from disk on every request", async () => {
    await withTempDir(async (dir) => {
        await Deno.writeTextFile(`${dir}/hello.txt`, "version one")
        const router: Router<never> = new Router<never>({})
        await router.mountFile("/hello", `${dir}/hello.txt`, false)

        const first = await router.requestHandler(new Request("http://localhost/hello"))
        assertEquals(await first.text(), "version one")

        await Deno.writeTextFile(`${dir}/hello.txt`, "version two")
        const second = await router.requestHandler(new Request("http://localhost/hello"))
        assertEquals(await second.text(), "version two")
    })
})

Deno.test("mountFile (memoized=false) surfaces a 500 (via server_error_handler) if the file is removed before a later request", async () => {
    await withTempDir(async (dir) => {
        await Deno.writeTextFile(`${dir}/hello.txt`, "content")
        const router: Router<never> = new Router<never>({
            server_error_handler: () => new Response("custom-500", { status: 500 }),
        })
        await router.mountFile("/hello", `${dir}/hello.txt`, false)

        const first = await router.requestHandler(new Request("http://localhost/hello"))
        assertEquals(first.status, 200)

        await Deno.remove(`${dir}/hello.txt`)
        // Deno.stat() throws inside the (async) file handler; requestHandler's own
        // error handling catches that and converts it via server_error_handler rather
        // than letting the request reject outright.
        const second = await router.requestHandler(new Request("http://localhost/hello"))
        assertEquals(second.status, 500)
        assertEquals(await second.text(), "custom-500")
    })
})

Deno.test("mountFile throws (rejects) at mount time if the target file does not exist", async () => {
    const router: Router<never> = new Router<never>({})
    await assertRejects(
        () => router.mountFile("/missing", "/definitely/does/not/exist-veloserver-test.txt"),
        Error,
    )
})

Deno.test("mountFiles mounts a nested directory tree at the matching URL structure", async () => {
    await withTempDir(async (dir) => {
        await Deno.mkdir(`${dir}/css`)
        await Deno.mkdir(`${dir}/js/vendor`, { recursive: true })
        await Deno.writeTextFile(`${dir}/index.html`, "<html>root</html>")
        await Deno.writeTextFile(`${dir}/css/site.css`, "body{color:red}")
        await Deno.writeTextFile(`${dir}/js/vendor/lib.js`, "console.log(1)")

        const router: Router<never> = new Router<never>({})
        await router.mountFiles("/static/", `${dir}/`)

        const html = await router.requestHandler(new Request("http://localhost/static/index.html"))
        assertEquals(await html.text(), "<html>root</html>")

        const css = await router.requestHandler(new Request("http://localhost/static/css/site.css"))
        assertEquals(await css.text(), "body{color:red}")
        assertEquals(css.headers.get("content-type")?.startsWith("text/css"), true)

        const js = await router.requestHandler(new Request("http://localhost/static/js/vendor/lib.js"))
        assertEquals(await js.text(), "console.log(1)")
    })
})

Deno.test("gzip is only used when it actually shrinks the file, and never without an explicit accept-encoding", async () => {
    await withTempDir(async (dir) => {
        // Highly repetitive text compresses well.
        await Deno.writeTextFile(`${dir}/big.txt`, "abababab ".repeat(500))
        const router: Router<never> = new Router<never>({})
        await router.mountFile("/big", `${dir}/big.txt`)

        const withoutHeader = await router.requestHandler(new Request("http://localhost/big"))
        assertEquals(withoutHeader.headers.get("content-encoding"), null)

        const withHeader = await router.requestHandler(new Request("http://localhost/big", {
            headers: { "accept-encoding": "gzip" },
        }))
        assertEquals(withHeader.headers.get("content-encoding"), "gzip")
        assertEquals(withHeader.headers.get("vary"), "accept-encoding")

        const decompressed = await new Response(
            withHeader.body?.pipeThrough(new DecompressionStream("gzip")),
        ).text()
        assertEquals(decompressed, "abababab ".repeat(500))
    })
})

Deno.test("the gzip ETag is distinct from the plain ETag, so a stale cached gzip response isn't served as plain", async () => {
    await withTempDir(async (dir) => {
        await Deno.writeTextFile(`${dir}/big.txt`, "abababab ".repeat(500))
        const router: Router<never> = new Router<never>({})
        await router.mountFile("/big", `${dir}/big.txt`)

        const plain = await router.requestHandler(new Request("http://localhost/big"))
        const gzipped = await router.requestHandler(new Request("http://localhost/big", {
            headers: { "accept-encoding": "gzip" },
        }))
        const plainEtag = plain.headers.get("etag")
        const gzipEtag = gzipped.headers.get("etag")
        assertEquals(gzipEtag, `${plainEtag}-gzip`)

        // Requesting with the gzip etag but no accept-encoding should not 304 -
        // it's a different representation.
        const mismatched = await router.requestHandler(new Request("http://localhost/big", {
            headers: { "if-none-match": gzipEtag! },
        }))
        assertEquals(mismatched.status, 200)
    })
})
