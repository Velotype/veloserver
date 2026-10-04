// The browser script that receives updates from the development server

/**
 * The hot update client, served at `/__velo/client.js` and loaded before the app
 *
 * It provides `import.meta.hot` to served modules, and applies the server's updates:
 * - `reload`: reload the page
 * - `bundle`: import the rebuilt app bundle again
 * - `modules`: import the modules that accept the update again
 * - `error`: log a build error, the page keeps running the last working code
 *
 * Updates go through the Velotype dev runtime's hot API (`globalThis.__VELOTYPE_HOT__`), and fall
 * back to a page reload when it is missing, has another version, or an update cannot be applied.
 */
export const clientScript = `// veloserver hot update client
const hotApiVersion = 1
const contexts = new Map()
const baseOf = (url) => new URL(url, location.href).href.replace(/[?#].*$/, "")

function contextOf(url) {
    const base = baseOf(url)
    let context = contexts.get(base)
    if (!context) {
        context = {data: {}, disposers: [], accepted: false}
        contexts.set(base, context)
    }
    return context
}

// import.meta.hot for served modules
globalThis.__VELO_HMR__ = {
    context(url) {
        const context = contextOf(url)
        return {
            get data() { return context.data },
            accept() { context.accepted = true },
            dispose(callback) { context.disposers.push(callback) },
        }
    },
}

function hotApi() {
    const hot = globalThis.__VELOTYPE_HOT__
    return hot && hot.version === hotApiVersion ? hot : undefined
}

function report(result) {
    console.log("[veloserver] updated: " + result.refreshed + " refreshed, " + result.remounted + " remounted")
}

async function applyUpdate(update) {
    if (update.type === "reload") {
        location.reload()
        return
    }
    if (update.type === "error") {
        console.error("[veloserver] build failed, the page keeps running the last working code\\n" + update.message)
        return
    }
    const hot = hotApi()
    if (!hot) {
        location.reload()
        return
    }
    if (update.type === "bundle") {
        const generation = hot.beginUpdate()
        try {
            await import(update.url + "?vt-hot=" + generation)
        } catch (error) {
            console.error("[veloserver] update failed, reloading", error)
            hot.endUpdate()
            location.reload()
            return
        }
        report(hot.endUpdate())
        return
    }
    if (update.type === "modules") {
        // Modules that re-run release what they set up
        for (const url of update.invalidated) {
            const context = contextOf(url)
            const disposers = context.disposers
            context.disposers = []
            context.accepted = false
            for (const dispose of disposers) {
                dispose(context.data)
            }
        }
        hot.beginUpdate(update.generation)
        let applied = true
        try {
            for (const url of update.boundaries) {
                const moduleExports = await import(url + "?vt-hot=" + update.generation)
                if (!contextOf(url).accepted && !hot.isComponentModule(moduleExports)) {
                    applied = false
                }
            }
        } catch (error) {
            console.error("[veloserver] update failed, reloading", error)
            applied = false
        }
        const result = hot.endUpdate()
        if (applied) {
            report(result)
        } else {
            location.reload()
        }
    }
}

// Updates are applied one at a time, in order
let queue = Promise.resolve()
let serverId
const events = new EventSource("/__velo/events")
events.onmessage = (message) => {
    const update = JSON.parse(message.data)
    if (update.type === "hello") {
        // A restarted server may serve different code, so reconnecting to it reloads the page
        if (serverId !== undefined && serverId !== update.id) {
            location.reload()
        }
        serverId = update.id
        return
    }
    queue = queue.then(() => applyUpdate(update))
}
`
