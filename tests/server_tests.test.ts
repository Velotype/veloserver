import { assertEquals } from "@std/assert"
import { Router, Server } from "@velotype/veloserver"

const FIXTURE_PATH = new URL("./fixtures/server_fixture.ts", import.meta.url)

async function waitForPing(port: number, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/ping`)
            await res.body?.cancel()
            if (res.ok) return
        } catch {
            // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`server on port ${port} never became reachable`)
}

function spawnFixture(port: number, markerFile: string, exitOnClose?: boolean) {
    const env: Record<string, string> = { TEST_PORT: String(port), TEST_MARKER_FILE: markerFile }
    if (exitOnClose !== undefined) {
        env["TEST_EXIT_ON_CLOSE"] = String(exitOnClose)
    }
    return new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-net", "--allow-env", "--allow-write", "--allow-sys", FIXTURE_PATH.pathname],
        env,
        stdout: "null",
        stderr: "piped",
    }).spawn()
}

/**
 * Awaits a child's exit, failing readably if it never comes.
 *
 * A bare `await child.status` hangs instead of failing when shutdown breaks: a swallowed signal
 * leaves the process sitting there and nothing ever resolves.
 */
async function statusWithin(child: Deno.ChildProcess, what: string, timeoutMs = 10000): Promise<Deno.CommandStatus> {
    let timer = 0
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    try {
        const status = await Promise.race([child.status, timeout])
        if (status === null) {
            try { child.kill("SIGKILL") } catch { /* already gone */ }
            await child.status
            throw new Error(`the server process did not exit within ${timeoutMs}ms: ${what}`)
        }
        return status
    } finally {
        clearTimeout(timer)
    }
}

async function readMarkers(markerFile: string): Promise<string[]> {
    try {
        const content = await Deno.readTextFile(markerFile)
        return content.split("\n").filter((line) => line.length > 0)
    } catch {
        return []
    }
}

Deno.test("Server starts, serves requests, and runs every registered listen callback", async () => {
    const port = 20000 + Math.floor(Math.random() * 5000)
    const markerFile = await Deno.makeTempFile()
    const child = spawnFixture(port, markerFile)

    try {
        await waitForPing(port)

        const res = await fetch(`http://127.0.0.1:${port}/ping`)
        assertEquals(res.status, 200)
        assertEquals(await res.text(), "pong")

        const markers = await readMarkers(markerFile)
        assertEquals(markers.includes("listen-callback-1"), true)
        assertEquals(markers.includes("listen-callback-2"), true)
        // shouldn't have shut down yet
        assertEquals(markers.includes("finished-callback-1"), false)
    } finally {
        try {
            child.kill("SIGKILL")
        } catch {
            // already exited
        }
        await child.status
        await Deno.remove(markerFile).catch(() => {})
    }
})

Deno.test("close() runs every finished callback and lets the process end on its own", async () => {
    const port = 20000 + Math.floor(Math.random() * 5000)
    const markerFile = await Deno.makeTempFile()
    const child = spawnFixture(port, markerFile)

    try {
        await waitForPing(port)

        const shutdownRes = await fetch(`http://127.0.0.1:${port}/shutdown`)
        assertEquals(await shutdownRes.text(), "shutting down")

        // Ends on its own, because nothing holds the event loop open once the listeners are gone
        const status = await statusWithin(child, "after close()")
        assertEquals(status.code, 0)

        const markers = await readMarkers(markerFile)
        assertEquals(markers.includes("finished-callback-1"), true)
        assertEquals(markers.includes("finished-callback-2"), true)
        // Work scheduled during shutdown got to run
        assertEquals(markers.includes("caller-resumed"), true)
    } finally {
        await Deno.remove(markerFile).catch(() => {})
    }
})

Deno.test("exitProcessOnClose ends the process immediately, without running what shutdown scheduled", async () => {
    const port = 20000 + Math.floor(Math.random() * 5000)
    const markerFile = await Deno.makeTempFile()
    const child = spawnFixture(port, markerFile, true)

    try {
        await waitForPing(port)
        await (await fetch(`http://127.0.0.1:${port}/shutdown`)).text()

        const status = await statusWithin(child, "after close()")
        assertEquals(status.code, 0)

        const markers = await readMarkers(markerFile)
        // Finished callbacks still run; anything they schedule does not
        assertEquals(markers.includes("finished-callback-2"), true)
        assertEquals(markers.includes("caller-resumed"), false)
    } finally {
        await Deno.remove(markerFile).catch(() => {})
    }
})

Deno.test("a Server can be started and closed inside a test without taking the test process with it", async () => {
    // If serve() ever exits the process again this does not fail - the run dies and reports
    // nothing, which is its own signal.
    const port = 20000 + Math.floor(Math.random() * 5000)
    const router = new Router<never>({})
    router.get("/ping", () => new Response("pong", { status: 200 }))

    const finished: string[] = []
    const server = new Server<never>(router)
    const closed = new Promise<void>((resolve) => {
        server.addServerFinishedCallback(() => {
            finished.push("finished")
            resolve()
        })
    })
    server.serve("127.0.0.1", port)

    await waitForPing(port)
    const res = await fetch(`http://127.0.0.1:${port}/ping`)
    assertEquals(await res.text(), "pong")

    server.close("in-process test done")
    await closed
    assertEquals(finished, ["finished"])

    // Still here, which is the point
    assertEquals(typeof Deno.pid, "number")
})

Deno.test("a termination signal shuts the server down gracefully rather than killing it outright", async () => {
    // A registered listener replaces the signal's default action, so a handler that stopped
    // aborting would leave the process ignoring SIGTERM entirely.
    const port = 20000 + Math.floor(Math.random() * 5000)
    const markerFile = await Deno.makeTempFile()
    const child = spawnFixture(port, markerFile)

    try {
        await waitForPing(port)
        child.kill("SIGTERM")

        const status = await statusWithin(child, "after SIGTERM - the signal handler may have stopped aborting")
        assertEquals(status.code, 0)

        // Graceful, not abrupt
        const markers = await readMarkers(markerFile)
        assertEquals(markers.includes("finished-callback-1"), true)
        assertEquals(markers.includes("finished-callback-2"), true)
    } finally {
        await Deno.remove(markerFile).catch(() => {})
    }
})

Deno.test("a listen callback that throws does not stop the server from serving", async () => {
    const port = 20000 + Math.floor(Math.random() * 5000)
    const router = new Router<never>({})
    router.get("/ping", () => new Response("pong", { status: 200 }))

    const ran: string[] = []
    const server = new Server<never>(router)
    server.addServerListenCallback(() => { throw new Error("listen callback blew up") })
    server.addServerListenCallback(() => { ran.push("second") })
    const closed = new Promise<void>((resolve) => server.addServerFinishedCallback(() => resolve()))
    server.serve("127.0.0.1", port)

    try {
        await waitForPing(port)
        assertEquals(await (await fetch(`http://127.0.0.1:${port}/ping`)).text(), "pong")
        // The throw is caught; later callbacks still run
        assertEquals(ran, ["second"])
    } finally {
        server.close("listen callback test done")
        await closed
    }
})

Deno.test("a finished callback that throws does not stop the ones after it", async () => {
    const port = 20000 + Math.floor(Math.random() * 5000)
    const router = new Router<never>({})
    router.get("/ping", () => new Response("pong", { status: 200 }))

    const ran: string[] = []
    const server = new Server<never>(router)
    server.addServerFinishedCallback(() => { ran.push("first") })
    server.addServerFinishedCallback(() => { throw new Error("finished callback blew up") })
    const closed = new Promise<void>((resolve) => {
        server.addServerFinishedCallback(() => { ran.push("third"); resolve() })
    })
    server.serve("127.0.0.1", port)

    await waitForPing(port)
    server.close("finished callback test done")
    await closed
    assertEquals(ran, ["first", "third"])
})

Deno.test("close() on a server that was never served is a no-op", () => {
    const server = new Server<never>(new Router<never>({}))
    server.close("never served")
    // Not throwing is the whole contract
    assertEquals(typeof server.close, "function")
})
