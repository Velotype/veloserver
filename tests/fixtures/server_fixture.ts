// Standalone fixture run as a subprocess by tests/server_tests.test.ts, so that the signal and
// shutdown paths are exercised against a real process. Proves callbacks ran by writing markers to a
// file (passed in via env) rather than parsing stdout.
import { Server, Router } from "@velotype/veloserver"

const port = Number(Deno.env.get("TEST_PORT"))
const markerFile = Deno.env.get("TEST_MARKER_FILE")
if (!markerFile) {
    throw new Error("TEST_MARKER_FILE env var is required")
}

function mark(line: string): void {
    Deno.writeTextFileSync(markerFile!, line + "\n", { append: true })
}

const router = new Router<never>({})
router.get("/ping", () => new Response("pong", { status: 200 }))
router.get("/shutdown", () => {
    // Respond first, then close on the next tick so the response actually reaches
    // the client before the listener goes away.
    setTimeout(() => server.close("test requested shutdown"), 10)
    return new Response("shutting down", { status: 200 })
})

const server = new Server<never>(router)
server.addServerListenCallback(() => mark("listen-callback-1"))
server.addServerListenCallback(() => mark("listen-callback-2"))
server.addServerFinishedCallback(() => mark("finished-callback-1"))
server.addServerFinishedCallback(() => mark("finished-callback-2"))

// Fires only if the process outlives its own shutdown, so it distinguishes the two modes. A timer
// rather than an `unload` listener, which may or may not run on Deno.exit().
server.addServerFinishedCallback(() => {
    setTimeout(() => mark("caller-resumed"), 50)
})

const exitOnClose = Deno.env.get("TEST_EXIT_ON_CLOSE") === "true"
server.serve("127.0.0.1", port, exitOnClose ? {exitProcessOnClose: true} : undefined)
