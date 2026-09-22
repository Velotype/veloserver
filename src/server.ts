import type {Router} from "./router.ts"

/** Used to represent a generic Callback function */
export type Callback = (()=>void) | (()=>Promise<void>)

/** Options for {@link Server.serve} */
export type ServeOptions = {
    /**
     * Call `Deno.exit(0)` once the server has finished shutting down (default: `false`)
     *
     * Leave unset when the server is one part of a longer-lived process - a test suite, a build
     * step - which should carry on after it stops. Set `true` to end the process the moment the
     * server does, even with other work still pending.
     */
    exitProcessOnClose?: boolean
}

/**
 * A Server process
 */
export class Server<ContextMetadata = never> {
    #router: Router<ContextMetadata>
    #server_listen_callbacks: Callback[] = []
    #server_finished_callbacks: Callback[] = []
    #abortController?: AbortController
    /**
     * Construct a new App to serve all routes contained in the given router
     */
    constructor(router: Router<ContextMetadata>) {
        this.#router = router
    }

    /** Add a callback to be called just after the server starts listening */
    addServerListenCallback(callback: Callback): void {
        this.#server_listen_callbacks.push(callback)
    }

    /** Add a callback to be called just after the server has finished */
    addServerFinishedCallback(callback: Callback): void {
        this.#server_finished_callbacks.push(callback)
    }

    /** Programmatically trigger the App to close */
    close(reason?: string): void {
        console.log(`Close triggered due to: ${reason} - Starting shutdown`)
        this.#abortController?.abort(`Closing due to: ${reason}`)
        this.#abortController = undefined
    }

    /** Call Deno.serve() on the given hostname and port */
    serve(hostname: string, port: number, options?: ServeOptions): void {
        this.#abortController = new AbortController()
        const server = Deno.serve({
            port: port,
            hostname: hostname,
            handler: this.#router.requestHandler,
            signal: this.#abortController.signal,
            onListen: async ({ port, hostname }) => {
                console.log(`Server started at http://${hostname}:${port} on host: ${Deno.hostname()} with deno version: ${Deno.version.deno}`)
                for (const callback of this.#server_listen_callbacks) {
                    try {
                        await callback()
                    } catch (e) {
                        console.log("Caught error during onListen while processing ListenCallbacks", e)
                    }
                }
            },
        })
        server.finished.then(async () => {
            console.log("Server closing")
            for (const callback of this.#server_finished_callbacks) {
                try {
                    await callback()
                } catch (e) {
                    console.log("Caught error during closing while processing FinishedCallbacks", e)
                }
            }
            console.log("Server closed")
            // A registered signal listener holds the event loop open, so the process cannot end
            // on its own until these are gone
            for (const [signal, handler] of signalHandlers) {
                Deno.removeSignalListener(signal, handler)
            }
            if (options?.exitProcessOnClose ?? false) {
                Deno.exit(0)
            }
        })
        const signals: Deno.Signal[] = ["SIGINT", "SIGTERM", "SIGUSR1"]
        const signalHandlers: [Deno.Signal, () => void][] = signals.map(signal => {
            const handler = () => {
                console.log(`Received ${signal} signal - Starting shutdown`)
                this.#abortController?.abort(`Received ${signal}`)
                this.#abortController = undefined
            }
            Deno.addSignalListener(signal, handler)
            return [signal, handler]
        })
    }
}
