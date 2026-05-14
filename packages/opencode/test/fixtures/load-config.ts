import path from "path"

const root = import.meta.dir

export function loadPermissionConfig(name: string) {
  return Bun.file(path.join(root, "permission-configs", `${name}.json`)).json()
}

export function loadScannerCorpus(): Promise<
  Array<{
    cmd: string
    expected_patterns: string[]
    expected_always: string[]
    expected_dirs: string[]
  }>
> {
  return Bun.file(path.join(root, "scanner-corpus.json")).json()
}
