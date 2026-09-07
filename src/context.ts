
/**
 * Extract a request's pathname without paying for a full WHATWG URL parse.
 */
function fastPathname(rawUrl: string): string | undefined {
    const schemeEnd = rawUrl.indexOf("://")
    if (schemeEnd === -1) {
        return undefined
    }
    const pathStart = rawUrl.indexOf("/", schemeEnd + 3)
    if (pathStart === -1) {
        return "/"
    }
    const questionChar = rawUrl.indexOf("?",pathStart)
    return rawUrl.substring(pathStart, (questionChar <= -1) ? rawUrl.length : questionChar)
}

/**
 * A generic Request Context, used to hold metadata about a request during processing
 */
export class Context<ContextMetadata = undefined> {
    /** The original Request this Context was created from */
    #request: Request

    /** The lazily-parsed URL of the Request (only built on first access to `url`) */
    #url?: URL

    /** Captured path variables (if any) */
    pathVariables?: Map<string,string>

    /** Statically structured metadata (useful for high frequency usage) */
    meta: ContextMetadata

    /** The array of path parts. Treat this as read-only: it is cached and shared across
     * every read of `getPathParts()` for this Context, so mutating it (e.g. `.shift()`)
     * corrupts it for every later reader in the same request. */
    #pathParts?: string[]

    /** Create a new Context from a Request */
    constructor(request: Request, meta: ContextMetadata) {
        this.#request = request
        this.meta = meta
    }
    /**
     * The original URL of the Request
     *
     * Parsed lazily on first access and cached - a request that never reads `url`
     * never pays for a full WHATWG URL parse.
     */
    get url(): URL {
        if (this.#url == undefined) {
            this.#url = new URL(this.#request.url)
        }
        return this.#url
    }
    /**
     * Get the array of path parts
     *
     * This is: `url.pathname.split("/")`
     */
    getPathParts(): string[] {
        if (this.#pathParts === undefined) {
            const pathname = fastPathname(this.#request.url)
            if (pathname === undefined) {
                throw new Error("Invalid url")
            }
            this.#pathParts = pathname.split("/")
        }
        return this.#pathParts
    }
    /** Capture a path variable in the context */
    addPathVariable(pathVariableName: string, pathVariableValue: string): void {
        if (this.pathVariables === undefined) {
            this.pathVariables = new Map<string,string>()
        }
        this.pathVariables.set(pathVariableName, pathVariableValue)
    }
}
