import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** A runner bound to a foreign CLI binary: `cliRunner('codex')(['mcp', 'add', …])`. */
export function cliRunner(bin: string) {
  return (args: string[]) => execFileP(bin, args)
}

/** Exit-code presence probe: true if `run` resolves, false if it throws. */
export function probeCli(run: () => Promise<unknown>): Promise<boolean> {
  return run().then(() => true, () => false)
}
