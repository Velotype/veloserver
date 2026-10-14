import { assert, assertEquals } from "@std/assert"

const FIXTURE_PATH = new URL("./fixtures/server_fixture.ts", import.meta.url)

/**
 * The server must need nothing beyond the network to serve. A program compiled with tight
 * permissions has no `--allow-sys`, and the startup log line once asked for the host name there,
 * which rejected inside `onListen` and killed the process after it had bound its port - a
 * locked-down deployment crashed on start for the sake of a log line.
 *
 * The fixture gets only what it needs for its own bookkeeping (env, and a file to write markers to).
 * `--no-prompt` makes any other permission request throw instead of waiting for a person, so a
 * future call to any sys API, in the start-up path or the serving path, fails this test.
 */
Deno.test("the server starts, serves and shuts down with no permission beyond network", async () => {
    const port = 25000 + Math.floor(Math.random() * 5000)
    const markerFile = await Deno.makeTempFile()
    const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-prompt", "--allow-net", "--allow-env", "--allow-write", FIXTURE_PATH.pathname],
        env: { TEST_PORT: String(port), TEST_MARKER_FILE: markerFile },
        stdout: "piped",
        stderr: "piped"
    }).spawn()

    try {
        const deadline = Date.now() + 10000
        let up = false
        while (Date.now() < deadline && !up) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/ping`)
                await res.body?.cancel()
                up = res.ok
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
        }
        assert(up, "the server never became reachable with only network permission")

        // a listen callback runs after the log line, so it proves onListen did not throw
        const markers = (await Deno.readTextFile(markerFile)).split("\n")
        assert(markers.includes("listen-callback-1"))

        const stop = await fetch(`http://127.0.0.1:${port}/shutdown`)
        await stop.body?.cancel()
        assertEquals((await child.status).code, 0)

        const stdout = new TextDecoder().decode(await new Response(child.stdout).bytes())
        const line = stdout.split("\n").find((l) => l.includes("Server started"))
        assert(line !== undefined, "no startup line was logged")
        assert(line.includes(`http://127.0.0.1:${port}`) && line.includes("deno version"), `startup line was: ${line}`)
        assertEquals(line.includes("host"), false, "the startup line must not ask the OS for anything")
    } finally {
        try { child.kill("SIGKILL") } catch { /* already exited */ }
        await Deno.remove(markerFile).catch(() => {})
    }
})
