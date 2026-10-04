// Building code for the browser with `deno bundle`

/** The project settings that every build uses */
export type BuildSettings = {
    /** The project directory, builds run from it */
    root: string
    /** The project's deno.json, for its import map and JSX settings, if it has one */
    config?: string
    /** Specifier patterns to leave as imports, such as `@velotype/velotype*` */
    externals: string[]
}

/** The output of a build, or the error it failed with */
export type BuildResult = {code: string, error?: undefined} | {code?: undefined, error: string}

/**
 * Run `deno bundle` on entry, returning its JavaScript
 *
 * @param extraExternals more specifiers to leave as imports
 */
export async function bundle(settings: BuildSettings, entry: string, extraExternals: string[] = []): Promise<BuildResult> {
    const args = ["bundle", "--sourcemap=inline"]
    if (settings.config) {
        args.push("--config", settings.config)
    }
    for (const external of [...settings.externals, ...extraExternals]) {
        // --external=<value>, since a separate value would also take the entry as an external
        args.push(`--external=${external}`)
    }
    args.push(entry)
    const output = await new Deno.Command(Deno.execPath(), {args, cwd: settings.root, stdout: "piped", stderr: "piped", env: {NO_COLOR: "1"}}).output()
    if (!output.success) {
        const error = new TextDecoder().decode(output.stderr).split("\n").filter(line => !line.includes("deno bundle is experimental")).join("\n").trim()
        return {error: error || `deno bundle failed for ${entry}`}
    }
    return {code: new TextDecoder().decode(output.stdout)}
}

/** Bundle a module that re-exports specifiers, such as a package or a set of entry points */
export async function bundleReexports(settings: BuildSettings, specifiers: string[], withDefault: boolean): Promise<BuildResult> {
    const dir = await Deno.makeTempDir({prefix: "veloserver-dev-"})
    try {
        const entry = `${dir}/entry.ts`
        const lines = specifiers.map(specifier => `export * from ${JSON.stringify(specifier)}`)
        if (withDefault) {
            lines.push(`export { default } from ${JSON.stringify(specifiers[0])}`)
        }
        await Deno.writeTextFile(entry, lines.join("\n") + "\n")
        return await bundle(settings, entry)
    } finally {
        await Deno.remove(dir, {recursive: true})
    }
}
