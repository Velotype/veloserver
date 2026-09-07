import { assertEquals } from "@std/assert"

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
    const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-net", "--allow-env", "--allow-write", "--allow-sys", FIXTURE_PATH.pathname],
        env: { TEST_PORT: String(port), TEST_MARKER_FILE: markerFile },
        stdout: "null",
        stderr: "piped",
    })
    const child = command.spawn()

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

Deno.test("Server.close() shuts the process down gracefully, running every finished callback, exiting 0", async () => {
    const port = 20000 + Math.floor(Math.random() * 5000)
    const markerFile = await Deno.makeTempFile()
    const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-net", "--allow-env", "--allow-write", "--allow-sys", FIXTURE_PATH.pathname],
        env: { TEST_PORT: String(port), TEST_MARKER_FILE: markerFile },
        stdout: "null",
        stderr: "piped",
    })
    const child = command.spawn()

    try {
        await waitForPing(port)

        const shutdownRes = await fetch(`http://127.0.0.1:${port}/shutdown`)
        assertEquals(await shutdownRes.text(), "shutting down")

        const status = await child.status
        assertEquals(status.code, 0)

        const markers = await readMarkers(markerFile)
        assertEquals(markers.includes("finished-callback-1"), true)
        assertEquals(markers.includes("finished-callback-2"), true)
    } finally {
        await Deno.remove(markerFile).catch(() => {})
    }
})
