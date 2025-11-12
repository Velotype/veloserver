// deno-lint-ignore-file no-explicit-any

/**
 * A generic Request Context, used to hold metadata about a request during processing
 */
export class Context<ContextMetadata = never> {
    /** The original URL of the Request */
    url: URL
    /** Captured path variables (if any) */
    pathVariables?: Map<string,string>
    /** A location to stash generic custom metadata about a request */
    metadata: Map<string,any> = new Map<string,any>()
    /** A location to stash the parsed jsonBody of a Request */
    jsonBody: any | undefined

    /** Statically structured metadata (useful for high frequency usage) */
    meta?: ContextMetadata

    /** The array of path parts */
    #pathParts?: string[]

    /** Create a new Context from a Request */
    constructor(request: Request, meta?: ContextMetadata) {
        this.url = new URL(request.url)
        this.meta = meta
    }
    /**
     * Get the array of path parts
     * 
     * This is the `url.pathname.split("/")`
     */
    getPathParts(): string[] {
        if (this.#pathParts == undefined) {
            this.#pathParts = (this.url.pathname || "/").split("/")
        }
        return this.#pathParts
    }
    /** Capture a path variable in the context */
    addPathVariable(pathVariableName: string, pathVariableValue: string): void {
        if (!this.pathVariables) {
            this.pathVariables = new Map<string,string>()
        }
        this.pathVariables.set(pathVariableName, pathVariableValue)
    }
    /** Stash generic metadata in the context (useful for dynamic data handling) */
    addMetadata(key: string, data: any): void {
        this.metadata.set(key, data)
    }
}
