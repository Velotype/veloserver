// Finding and rewriting the import specifiers of JavaScript and TypeScript modules

/**
 * Matches the specifier of a static import or export (`import x from "a"`, `import "a"`,
 * `export * from "a"`) or of a dynamic import with a string literal (`import("a")`)
 *
 * Group 1 is the text before the specifier, group 2 its quote, group 3 the specifier
 */
const specifierPattern = /(\bimport\s*\(\s*|\bimport\s+|\bfrom\s*)(["'])([^"'\n]+)\2/g

/** The specifiers that code imports, in order and without duplicates */
export function findSpecifiers(code: string): string[] {
    const specifiers = new Set<string>()
    for (const match of code.matchAll(specifierPattern)) {
        specifiers.add(match[3])
    }
    return [...specifiers]
}

/** Replace each import specifier in code with the result of rewrite() */
export function rewriteSpecifiers(code: string, rewrite: (specifier: string) => string): string {
    return code.replace(specifierPattern, (_match, before: string, quote: string, specifier: string) => before + quote + rewrite(specifier) + quote)
}

/** Is specifier relative to the importing module (`./a.ts`, `../a.ts`) */
export function isRelativeSpecifier(specifier: string): boolean {
    return specifier.startsWith("./") || specifier.startsWith("../")
}

/** Is specifier a URL or an absolute path, which the browser loads as-is */
export function isUrlSpecifier(specifier: string): boolean {
    return specifier.startsWith("/") || /^(https?|data|blob):/.test(specifier)
}

/** Matches the specifiers of the Velotype package and its entry points */
const velotypePattern = /^(jsr:|npm:)?@velotype\/velotype(@[^/]+)?(\/(jsx-runtime|jsx-dev-runtime|devtools))?$|^npm:@jsr\/velotype__velotype(@[^/]+)?(\/.*)?$/

/** Is specifier the Velotype package or one of its entry points, such as `jsr:@velotype/velotype/jsx-dev-runtime` */
export function isVelotypeSpecifier(specifier: string, jsxImportSource?: string): boolean {
    if (velotypePattern.test(specifier)) {
        return true
    }
    return jsxImportSource !== undefined && (specifier === jsxImportSource || specifier.startsWith(jsxImportSource + "/"))
}

/**
 * The exports of a module transpiled by `deno bundle`, as a map of exported names to local names
 *
 * Reads the `export { a, b as c }` and `export default a` statements that the bundler writes
 */
export function findExports(code: string): Map<string, string> {
    const exports = new Map<string, string>()
    for (const match of code.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
        for (const part of match[1].split(",")) {
            const names = part.trim().split(/\s+as\s+/)
            if (names[0]) {
                exports.set(names[1] || names[0], names[0])
            }
        }
    }
    const defaultExport = code.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m)
    if (defaultExport) {
        exports.set("default", defaultExport[1])
    }
    return exports
}
