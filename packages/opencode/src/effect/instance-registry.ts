const disposers = new Set<(directory: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}

/** Config hot-reload channel — deliberately SEPARATE from the disposal set.
 *
 * Disposal tears down everything an instance owns (bus pubsubs publish
 * InstanceDisposed, PTYs die, pending permissions clear). A config change
 * must touch none of that: only caches DERIVED from config may flush, and
 * they rebuild lazily on next access. Subsystems opt in via
 * `InstanceState.make(init, { configDependent })`.
 *
 * Scopes: "always" flushes on any config change; "mcp" / "lsp" / "plugin"
 * flush only when their slice of the resolved config actually changed —
 * those three hold live child processes or loaded modules, and restarting
 * them because an unrelated key moved is the kind of collateral a restart
 * button would inflict. */
export type ConfigInvalidateScope = "always" | "mcp" | "lsp" | "plugin"

const configInvalidators = new Map<ConfigInvalidateScope, Set<(directory: string) => Promise<void>>>()

export function registerConfigInvalidator(
  scope: ConfigInvalidateScope,
  invalidator: (directory: string) => Promise<void>,
) {
  const set = configInvalidators.get(scope) ?? new Set()
  set.add(invalidator)
  configInvalidators.set(scope, set)
  return () => {
    set.delete(invalidator)
  }
}

/** Flush config-derived caches for one directory. `slices` names the config
 * slices that actually changed; gated scopes run only when listed. */
export async function invalidateConfigDependents(directory: string, slices: ConfigInvalidateScope[]) {
  const targets = ["always" as const, ...slices.filter((s) => s !== "always")]
  await Promise.allSettled(
    targets.flatMap((scope) => [...(configInvalidators.get(scope) ?? [])].map((invalidator) => invalidator(directory))),
  )
}
