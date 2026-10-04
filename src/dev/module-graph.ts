// The graph of served modules, used to find which modules re-run when a file changes

/** A served module */
type ModuleNode = {
    /** The modules this module imports, by file path */
    imports: Set<string>
    /** The modules that import this module, by file path */
    importers: Set<string>
    /** If this module can be replaced on its own (it only exports components, or calls `import.meta.hot.accept()`) */
    accepts: boolean
    /** The generation this module was last re-run in, 0 when it has not changed since the page loaded */
    version: number
}

/** The modules that re-run for a change, or a full page reload when the change reaches a module that cannot be replaced */
export type Propagation = {reload: true} | {
    reload: false
    /** The modules that accept the update, which are imported again */
    boundaries: string[]
    /** Every module that re-runs: the boundaries and the modules between them and the changed file */
    invalidated: string[]
}

/** The graph of served modules, by file path */
export class ModuleGraph {
    #nodes = new Map<string, ModuleNode>()

    #node(file: string): ModuleNode {
        let node = this.#nodes.get(file)
        if (!node) {
            node = {imports: new Set(), importers: new Set(), accepts: false, version: 0}
            this.#nodes.set(file, node)
        }
        return node
    }

    /** Is file a served module */
    has(file: string): boolean {
        return this.#nodes.has(file)
    }

    /** Record a module's imports and if it accepts updates, from its latest transpiled code */
    update(file: string, imports: string[], accepts: boolean): void {
        const node = this.#node(file)
        for (const imported of node.imports) {
            this.#nodes.get(imported)?.importers.delete(file)
        }
        node.imports = new Set(imports)
        for (const imported of imports) {
            this.#node(imported).importers.add(file)
        }
        node.accepts = accepts
    }

    /** The generation a module was last re-run in (added to its URL so that the browser loads it again) */
    version(file: string): number {
        return this.#nodes.get(file)?.version || 0
    }

    /** Set the version of modules that re-run in generation */
    bump(files: string[], generation: number): void {
        for (const file of files) {
            this.#node(file).version = generation
        }
    }

    /** The modules that re-run when file changes */
    propagate(file: string): Propagation {
        const boundaries = new Set<string>()
        const invalidated = new Set<string>()
        const queue = [file]
        while (queue.length > 0) {
            const current = queue.shift()!
            if (invalidated.has(current)) {
                continue
            }
            invalidated.add(current)
            const node = this.#nodes.get(current)
            if (!node) {
                continue
            }
            if (node.accepts) {
                boundaries.add(current)
                continue
            }
            if (node.importers.size === 0) {
                // Reached an entry module
                return {reload: true}
            }
            queue.push(...node.importers)
        }
        return {reload: false, boundaries: [...boundaries], invalidated: [...invalidated]}
    }
}
