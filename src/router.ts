import {contentType} from "@std/media-types/content-type"
import {eTag} from "@std/http/etag"

import {Context} from "./context.ts"

const status200 = {status: 200}
const status304 = {status: 304}
const status404 = {status: 404}
const status500 = {status: 500}

/**
 * RequestInspectors return this object
 * 
 * `this.response` is mutually exclusive with `this.shouldContinue`
 * 
 * if `this.response` is set then the Request call chain is ended early
 * and `response` is used to start the Response call chain
 */
export class RequestInspectorResponse {
    /** The Response to use if the call chain should be halted */
    response?: Response = undefined
    /** A boolean to explicitly flag if the call chain should continue */
    shouldContinue: boolean
    /** Create a new RequestInspectorResponse */
    constructor(shouldContinue: boolean, response?: Response) {
        this.shouldContinue = shouldContinue
        this.response = response
    }
}

/** A Request Handler that processes a Request with a given Context */
export type Handler<ContextMetadata = never> = (request: Request, context: Context<ContextMetadata>) => Response | Promise<Response>

/** A Request Inspector */
export type RequestInspector<ContextMetadata = never> = (request: Request, context: Context<ContextMetadata>) => RequestInspectorResponse | Promise<RequestInspectorResponse>

/** A Response Inspector */
export type ResponseInspector<ContextMetadata = never> = (request: Request, response: Response, context: Context<ContextMetadata>) => void | Promise<void>

/** A pair of Request and Response Inspectors (each optional) */
export class Inspector<ContextMetadata = never> {
    /** A Request Inspector (if set) */
    requestInspector?: RequestInspector<ContextMetadata>
    /** A Response Inspector (if set) */
    responseInspector?: ResponseInspector<ContextMetadata>
    /** If this Inspector should inspect child paths (default true) */
    observeChildPaths: boolean
    /** Create a new Inspector pair */
    constructor(requestInspector?: RequestInspector<ContextMetadata> | undefined, responseInspector?: ResponseInspector<ContextMetadata>, observeChildPaths?: boolean) {
        this.requestInspector = requestInspector
        this.responseInspector = responseInspector
        this.observeChildPaths = (observeChildPaths != undefined) ? observeChildPaths : true
    }
}

class RouteNode<ContextMetadata> {
    pathSegment: string = ""
    isWildcard: boolean = false
    pathVariable: string = ""
    inspectors: Inspector<ContextMetadata>[] = []
    childNodes: RouteNode<ContextMetadata>[] = []
    handler: Handler<ContextMetadata> | undefined = undefined
    setPathSegment(pathSegment: string): void {
        this.pathSegment = pathSegment
    }
    setIsWildcard(isWildcard: boolean, pathVariable?: string): void {
        this.isWildcard = isWildcard
        if (pathVariable) {
            this.pathVariable = pathVariable
        }
    }
    addInspector(inspector: Inspector<ContextMetadata>): void {
        this.inspectors.push(inspector)
    }
    setHandler(handler: Handler<ContextMetadata>): void {
        if (this.handler) {
            console.log("ERROR RouteNode setHandler called twice for the same route", this)
        } else {
            this.handler = handler
        }
    }
    addChildNode(routeNode: RouteNode<ContextMetadata>): void {
        this.childNodes.push(routeNode)
    }
    addPathHandler(pathSegments: string[], handler: Handler<ContextMetadata>): void {
        this.addPathPropertyHelper(pathSegments, (node: RouteNode<ContextMetadata>) => {
            node.setHandler(handler)
        })
    }
    addPathInspector(pathSegments: string[], inspector: Inspector<ContextMetadata>): void {
        this.addPathPropertyHelper(pathSegments, (node: RouteNode<ContextMetadata>) => {
            node.addInspector(inspector)
        })
    }
    addPathPropertyHelper(pathSegments: string[], setClosure: (node: RouteNode<ContextMetadata>) => void): void {
        if (pathSegments.length == 0) {
            setClosure(this)
            return
        }
        const pathSegment = pathSegments[0]
        pathSegments.shift()
        if (pathSegment == "*") {
            if (pathSegments.length > 0) {
                console.log(`ERROR Route validation error, RouteNode with wildcard child has more path segments, pathSegments.length: ${pathSegments.length}`)
            } else {
                const newChild = new RouteNode<ContextMetadata>()
                newChild.setIsWildcard(true, "*")
                setClosure(newChild)
                this.addChildNode(newChild)
            }
        } else if (pathSegment.length > 1 && pathSegment.charAt(0) == ":") {
            const pathVariable = pathSegment.substring(1)
            if (this.childNodes.length > 1) {
                console.log(`ERROR Route validation error, RouteNode with pathVariable child has more than one child, childNodes.length: ${this.childNodes.length} pathSegment: ${this.pathSegment}`)
            }
            const child = this.childNodes.find(node => node.isWildcard)
            if (child) {
                if (child.pathVariable != pathVariable) {
                    console.log(`ERROR Route validation error, path variable segments require global consistency current route pathVariable is: ${child.pathVariable} while trying to register: ${pathVariable}`)
                }
                if (pathSegments.length == 0) {
                    setClosure(child)
                } else {
                    child.addPathPropertyHelper(pathSegments, setClosure)
                }
            } else {
                const newChild = new RouteNode<ContextMetadata>()
                newChild.setIsWildcard(true, pathVariable)
                if (pathSegments.length == 0) {
                    setClosure(newChild)
                } else {
                    newChild.addPathPropertyHelper(pathSegments, setClosure)
                }
                this.addChildNode(newChild)
            }
        } else {
            const child = this.childNodes.find(node => node.pathSegment == pathSegment)
            if (child) {
                if (pathSegments.length == 0) {
                    setClosure(child)
                } else {
                    child.addPathPropertyHelper(pathSegments, setClosure)
                }
            } else {
                const newChild = new RouteNode<ContextMetadata>()
                newChild.setPathSegment(pathSegment)
                if (pathSegments.length == 0) {
                    setClosure(newChild)
                } else {
                    newChild.addPathPropertyHelper(pathSegments, setClosure)
                }
                this.addChildNode(newChild)
            }
        }
    }
}

const readTrue = {read: true}
const pathSegmentsFromPath = function(path: string) {
    const pathSegments: string[] = path.split("/")
    pathSegments.shift()
    return pathSegments
}

const default_not_found_handler = function() {
    const response = new Response("<!DOCTYPE html><html><body>Not Found</body></html>", status404)
    response.headers.set("content-type", "text/html; charset=utf-8")
    return response
}
const default_server_error_handler = function() {
    return new Response("Internal Server Error", status500)
}

/**
 * A Router is an object that handles processing requests and routing them to
 * various handlers and inspectors.
 */
export class Router<ContextMetadata> {
    #get_routes: RouteNode<ContextMetadata> = new RouteNode()
    #head_routes: RouteNode<ContextMetadata> = new RouteNode()
    #post_routes: RouteNode<ContextMetadata> = new RouteNode()
    #context_metadata_constructor: (requet: Request) => ContextMetadata
    #not_found_handler: Handler<ContextMetadata>
    #server_error_handler: Handler<ContextMetadata>

    /**
     * Create a new Rounter with optional backup Handlers in case of NotFound and InternalServerError cases
     */
    constructor({
        not_found_handler,
        server_error_handler,
        context_metadata_constructor
    }: {
        not_found_handler?: Handler<ContextMetadata>,
        server_error_handler?: Handler<ContextMetadata>,
        context_metadata_constructor: (request: Request) => ContextMetadata
    }) {
        this.#context_metadata_constructor = context_metadata_constructor
        this.#not_found_handler = not_found_handler || default_not_found_handler
        this.#server_error_handler = server_error_handler || default_server_error_handler
    }

    /** Convience method to construct an HTTP 200 JSON encoded response */
    // deno-lint-ignore no-explicit-any
    static jsonResponse(data: any): Response {
        const response = new Response(JSON.stringify(data), status200)
        response.headers.set("content-type", "text/json; charset=utf-8")
        return response
    }

    #processResponseInspectors = async (responseInspectors: ResponseInspector<ContextMetadata>[], request: Request, response: Response | Promise<Response>, context: Context<ContextMetadata>): Promise<Response> => {
        const responseObj: Response = (response instanceof Promise) ? await response : response
        for(const responseInspector of responseInspectors) {
            const responseInspectorResponse = responseInspector(request, responseObj, context)
            if (responseInspectorResponse instanceof Promise) {
                await responseInspectorResponse
            }
        }
        return response
    }

    #addPathHandlerToNode(routeNode: RouteNode<ContextMetadata>, paths: string | string[], handler: Handler<ContextMetadata>) {
        if (Array.isArray(paths)) {
            paths.forEach(path => {
                routeNode.addPathHandler(pathSegmentsFromPath(path), handler)
            })
        } else {
            routeNode.addPathHandler(pathSegmentsFromPath(paths), handler)
        }
    }
    #addPathInspectorToNode(routeNode: RouteNode<ContextMetadata>, paths: string | string[], inspector: Inspector<ContextMetadata>) {
        if (Array.isArray(paths)) {
            paths.forEach(path => {
                routeNode.addPathInspector(pathSegmentsFromPath(path), inspector)
            })
        } else {
            routeNode.addPathInspector(pathSegmentsFromPath(paths), inspector)
        }
    }

    /** Add a Handler for an HTTP GET path */
    get(paths: string | string[], handler: Handler<ContextMetadata>): void {
        this.#addPathHandlerToNode(this.#get_routes, paths, handler)
    }
    /** Add a Handler for an HTTP HEAD path */
    head(paths: string | string[], handler: Handler<ContextMetadata>): void {
        this.#addPathHandlerToNode(this.#head_routes, paths, handler)
    }
    /** Add a Handler for an HTTP POST path */
    post(paths: string | string[], handler: Handler<ContextMetadata>): void {
        this.#addPathHandlerToNode(this.#post_routes, paths, handler)
    }
    /** Add an Inspector for an HTTP GET path */
    addGetInspector(paths: string | string[], inspector: Inspector<ContextMetadata>): void {
        this.#addPathInspectorToNode(this.#get_routes, paths, inspector)
    }
    /** Add an Inspector for an HTTP HEAD path */
    addHeadInspector(paths: string | string[], inspector: Inspector<ContextMetadata>): void {
        this.#addPathInspectorToNode(this.#head_routes, paths, inspector)
    }
    /** Add an Inspector for an HTTP POST path */
    addPostInspector(paths: string | string[], inspector: Inspector<ContextMetadata>): void {
        this.#addPathInspectorToNode(this.#post_routes, paths, inspector)
    }
    /** Add an Inspector for a HTTP GET, HEAD, and POST path */
    addAllInspector(paths: string | string[], inspector: Inspector<ContextMetadata>): void {
        this.addGetInspector(paths,inspector)
        this.addHeadInspector(paths,inspector)
        this.addPostInspector(paths,inspector)
    }

    /**
     * Process a Request, passed to Deno.serve() by the wrapped App
     */
    requestHandler = async (request: Request): Promise<Response> => {
        const context: Context<ContextMetadata> = new Context<ContextMetadata>(request, this.#context_metadata_constructor(request))
        try {
            let nextRouteNode: RouteNode<ContextMetadata> | undefined
            if (request.method == "GET") {
                nextRouteNode = this.#get_routes
            } else if (request.method == "HEAD") {
                nextRouteNode = this.#head_routes
            } else if (request.method == "POST") {
                nextRouteNode = this.#post_routes
            }
            if (!nextRouteNode) {
                // Unsupported method
                console.log(`WARN Called with unsupported method: ${request.method}`)
                return this.#not_found_handler(request,context)
            }
            const pathParts = context.getPathParts()
            pathParts.shift()
            const responseInspectors: ResponseInspector<ContextMetadata>[] = []
            let closestWildcard = undefined
            while(nextRouteNode) {
                // Process inspectors for this node
                for(const inspector of nextRouteNode.inspectors) {
                    if (inspector.requestInspector && (pathParts.length == 0 || inspector.observeChildPaths)) {
                        let requestInspectorResponse = inspector.requestInspector(request, context)
                        if (requestInspectorResponse instanceof Promise) {
                            requestInspectorResponse = await requestInspectorResponse
                        }
                        if (requestInspectorResponse.response) {
                            return this.#processResponseInspectors(responseInspectors, request, requestInspectorResponse.response, context)
                        } else if (!requestInspectorResponse.shouldContinue) {
                            console.log(`ERROR Middleware did not provide a response yet shouldContinue was false request pathname: ${context.url.pathname}`)
                            return this.#processResponseInspectors(responseInspectors, request, this.#server_error_handler(request,context), context)
                        }
                    }
                    if (inspector.responseInspector && (pathParts.length == 0 || inspector.observeChildPaths)) {
                        responseInspectors.push(inspector.responseInspector)
                    }
                }
                // No more parts, so time to process the route's handler
                if (pathParts.length == 0) {
                    if (nextRouteNode.handler) {
                        return this.#processResponseInspectors(responseInspectors, request, nextRouteNode.handler(request,context), context)
                    }
                    return this.#processResponseInspectors(responseInspectors, request, this.#not_found_handler(request,context), context)
                }
                const pathSegment = pathParts[0]
                pathParts.shift()

                // If there is a splat wildcard child, capture for later
                const wildcardSplitChild = nextRouteNode.childNodes.find(routeNode => (routeNode.isWildcard && routeNode.pathVariable == "*"))
                if (wildcardSplitChild && wildcardSplitChild.handler) {
                    closestWildcard = wildcardSplitChild
                }

                nextRouteNode = nextRouteNode.childNodes.find(routeNode => (routeNode.isWildcard || routeNode.pathSegment == pathSegment))
                if (nextRouteNode && nextRouteNode.isWildcard && nextRouteNode.pathVariable != "*") {
                    context.addPathVariable(nextRouteNode.pathVariable, pathSegment)
                }
            }
            if (closestWildcard && closestWildcard.handler) {
                return this.#processResponseInspectors(responseInspectors, request, closestWildcard.handler(request,context), context)
            }
            return this.#processResponseInspectors(responseInspectors, request, this.#not_found_handler(request,context), context)
        } catch (error) {
            console.log("ERROR", error)
            return this.#server_error_handler(request, context)
        }
    }

    /**
     * Mount a directory of files to a given path (mounts the files on HTTP GET)
     * 
     * This will preload the files into memory and serve from memory on each request
     * 
     * @param memoized - if the file should be read only once and held in-memory (true by default)
     */
    async mountFiles(mountDir: string, targetDir: string, memoized: boolean = true): Promise<void> {
        console.log(`Mounting memoized target dir: ${targetDir} to mount: ${mountDir}`)
        for (const dirEntry of Deno.readDirSync(targetDir)) {
            if (dirEntry.isFile) {
                if (memoized) {
                    console.log(`Serving file directly: ${targetDir + dirEntry.name}`)
                    this.get(mountDir + dirEntry.name, this.#serveFile(targetDir + dirEntry.name))
                } else {
                    console.log(`Serving file memoized: ${targetDir + dirEntry.name}`)
                    this.get(mountDir + dirEntry.name, await this.#serveMemoizedFile(targetDir + dirEntry.name))
                }
            } else if (dirEntry.isDirectory) {
                this.mountFiles(mountDir + dirEntry.name + "/", targetDir + dirEntry.name + "/", memoized)
            } else if (dirEntry.isSymlink) {
                console.log(`ERROR Attempted to mount a symlink, this is not supported name: ${dirEntry.name}`)
            }
        }
    }

    #serveFile(path: string): Handler<ContextMetadata> {
        console.log(`Loaded file path: ${path}`)
        return async (request: Request, context: Context<ContextMetadata>) => {
            const fileInfo = await Deno.stat(path)
            if (fileInfo.isFile) {
                const file = await Deno.open(path, readTrue)
                const response = new Response(file.readable)
                const ext = path.substring(1 + path.lastIndexOf("."))
                response.headers.set("content-type", contentType(ext) || "application/text")
                return response
            } else {
                return this.#not_found_handler(request,context)
            }
        }
    }

    //TODO compress early as part of memoization
    // https://docs.deno.com/runtime/fundamentals/http_server/#automatic-body-compression
    // https://github.com/oakserver/oak/blob/main/send.ts#L167
    //TODO support Cache-Control
    async #serveMemoizedFile(path: string) {
        const fileInfo = Deno.statSync(path)
        if (fileInfo.isFile) {
            const ext = path.substring(1 + path.lastIndexOf("."))
            const contentTypeHeader = contentType(ext) || "application/text"
            const file = Deno.openSync(path, readTrue)
            const buf = new Uint8Array(fileInfo.size)
            const numberOfBytesRead = file.readSync(buf)
            const etag = await eTag(buf)
            console.log(`Loaded memoized file path: ${path} bytes: ${numberOfBytesRead} etag: ${etag}`)
            if (numberOfBytesRead == fileInfo.size) {
                return (request: Request, _context: Context<ContextMetadata>) => {
                    const ifNoneMatch = request.headers.get("if-none-match")
                    if (ifNoneMatch && ifNoneMatch == etag) {
                        const response = new Response(null, status304)
                        response.headers.set("content-type", contentTypeHeader)
                        response.headers.set("etag", etag)
                        return response
                    } else {
                        const response = new Response(buf)
                        response.headers.set("content-type", contentTypeHeader)
                        response.headers.set("etag", etag)
                        return response
                    }
                }
            } else {
                return this.#server_error_handler
            }
        } else {
            console.log(`ERROR failed to load file, is not a file at path: ${path}`)
            return this.#server_error_handler
        }
    }
}
