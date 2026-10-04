// The project's deno.json, and the copy of it that development builds use

// deno-lint-ignore no-explicit-any
type Json = any

/** Remove comments and trailing commas (allowed in deno.jsonc) from JSON text */
export function stripJsonComments(text: string): string {
    let output = ""
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (inString) {
            output += char
            if (char === "\\") {
                output += text[++i] || ""
            } else if (char === '"') {
                inString = false
            }
        } else if (char === '"') {
            inString = true
            output += char
        } else if (char === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++
            output += "\n"
        } else if (char === "/" && text[i + 1] === "*") {
            i += 2
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
            i++
        } else {
            output += char
        }
    }
    // Trailing commas, outside of strings since comments and strings are handled above
    return output.replace(/,(\s*[}\]])/g, "$1")
}

/** The project's config file and its contents */
export type ProjectConfig = {path: string, json: Json}

/** Read config, or the deno.json (or deno.jsonc) in root */
export function readProjectConfig(root: string, config?: string): ProjectConfig | undefined {
    const candidates = config ? [config.startsWith("/") ? config : `${root}/${config}`] : [`${root}/deno.json`, `${root}/deno.jsonc`]
    for (const path of candidates) {
        let text: string
        try {
            text = Deno.readTextFileSync(path)
        } catch {
            continue
        }
        return {path, json: JSON.parse(stripJsonComments(text))}
    }
    return undefined
}

/** Make a relative path in the config absolute, as a file URL */
function absolute(value: unknown, base: URL): unknown {
    return typeof value === "string" && (value.startsWith("./") || value.startsWith("../")) ? new URL(value, base).href : value
}

/**
 * Write the config that development builds use: the project's config with `"jsx": "react-jsxdev"`, so
 * that the app uses the Velotype dev runtime, and with its relative paths made absolute since it is
 * written to another directory
 */
export function writeDevConfig(project: ProjectConfig | undefined, dir: string): string {
    const json: Json = project ? structuredClone(project.json) : {}
    const base = project ? new URL(`file://${project.path}`) : undefined
    json.compilerOptions = {...json.compilerOptions, jsx: "react-jsxdev"}
    if (base) {
        for (const key of Object.keys(json.imports || {})) {
            json.imports[key] = absolute(json.imports[key], base)
        }
        for (const scope of Object.keys(json.scopes || {})) {
            for (const key of Object.keys(json.scopes[scope])) {
                json.scopes[scope][key] = absolute(json.scopes[scope][key], base)
            }
        }
        if (typeof json.importMap === "string") {
            json.importMap = absolute(json.importMap.startsWith(".") ? json.importMap : "./" + json.importMap, base)
        }
        // Keep using the project's lock file
        const lock = typeof json.lock === "string" ? json.lock : (json.lock === false ? undefined : "deno.lock")
        json.lock = lock ? new URL(lock.startsWith(".") ? lock : "./" + lock, base).pathname : false
    }
    // Workspace members and tasks do not apply to builds
    delete json.workspace
    delete json.tasks
    const path = `${dir}/deno.json`
    Deno.writeTextFileSync(path, JSON.stringify(json, null, 2))
    return path
}
