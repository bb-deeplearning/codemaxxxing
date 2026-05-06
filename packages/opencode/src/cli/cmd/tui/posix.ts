import type { ReadStream } from "node:tty"

/**
 * Wrap `process.stdin.setRawMode` to catch EBADF (errno 9) without throwing.
 *
 * Why: opentui calls `setRawMode(...)` at every render-loop entry point
 * (start, resume, suspend, theme refresh) without try/catch. If the TTY fd
 * has been transiently invalidated — mosh packet drop, tmux pane swap,
 * ssh keepalive blip, terminal app suspend/resume, etc. — the call throws
 * with errno 9 (EBADF). The exception bubbles up uncaught, lands at our
 * top-level `process.on("uncaughtException")` which only logs, but the
 * renderer is now in a half-set-up state. The next stdout write throws EIO
 * for the same reason. The TUI's main loop gives up, returns, and the
 * `finally { stop() }` in `thread.ts` shuts the worker down.
 *
 * Net effect: any transient TTY blip kills cmx even though the disturbance
 * itself was recoverable.
 *
 * The wrapper swallows EBADF (transient — TTY is gone for a moment, no
 * point in propagating) and re-throws anything else (don't mask real bugs).
 *
 * Pairs with `win32InstallCtrlCGuard` — call both at every TUI entry point.
 *
 * Returns an `unhook()` to restore the original on exit.
 */
export function installPosixRawModeGuard(): (() => void) | undefined {
  if (process.platform === "win32") return
  if (!process.stdin.isTTY) return

  const stdin = process.stdin as ReadStream
  const original = stdin.setRawMode
  if (typeof original !== "function") return

  const wrapped: ReadStream["setRawMode"] = function (mode: boolean) {
    try {
      return original.call(stdin, mode)
    } catch (err) {
      // EBADF (errno 9): fd is dangling. Transient TTY disconnect — let opentui
      // continue. The next call usually succeeds once the terminal layer
      // recovers (mosh reconnects, tmux finishes its swap, etc).
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      const errno = (err as NodeJS.ErrnoException | undefined)?.errno
      if (code === "EBADF" || errno === -9 || errno === 9) {
        return stdin
      }
      throw err
    }
  } as ReadStream["setRawMode"]

  stdin.setRawMode = wrapped

  let done = false
  return () => {
    if (done) return
    done = true
    if (stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }
  }
}
