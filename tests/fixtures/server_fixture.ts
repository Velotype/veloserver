// Standalone fixture run as a subprocess by tests/server_tests.test.ts.
//
// Server.serve() calls Deno.exit(0) once it finishes shutting down, which would
// kill the whole `deno test` process if Server were exercised in-process - so this
// fixture is spawned as its own Deno process instead, and proves callbacks actually
// ran by writing markers to a file (passed in via env) rather than parsing stdout.
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

server.serve("127.0.0.1", port)
