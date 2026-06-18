// session.js — wrap one hvc console handle (from bootLinux().console(vt)) with
// convenience session behaviors (line buffering, hangup, hooks). Generic: no
// VFS dependency. The pc Terminal app and the node CLI both layer on this.

/**
 * Wrap one boot.js console seam as a TerminalSession.
 * @param {{ write(b: Uint8Array|string): void, onData(cb: (b: Uint8Array)=>void): () => void, resize(c: number, r: number): void }} con
 * @param {{ onKill?: () => void }} [hooks]
 * @returns {{ write(b: Uint8Array|string): void, onData(cb: (b: Uint8Array)=>void): () => void, resize(c: number, r: number): void, kill(): void, hangup(text?: string): void }}
 */
export function makeConsoleSession(con, hooks = {}) {
  let killed = false;
  /** @type {Set<(b: Uint8Array) => void>} renderer callbacks (for hangup) */
  const listeners = new Set();
  /** @type {Set<() => void>} console-side unsubscribers for every onData() */
  const unsubs = new Set();
  return {
    write(data) {
      if (!killed) con.write(data);
    },
    onData(cb) {
      if (killed) return () => {};
      const off = con.onData(cb);
      listeners.add(cb);
      unsubs.add(off);
      return () => {
        listeners.delete(cb);
        unsubs.delete(off);
        off();
      };
    },
    // Propagate the renderer's size to the kernel (TIOCSWINSZ → __hvc_resize):
    // boot's console seam writes it to the shared winsize array the hvc driver
    // polls, so the guest tty (and SIGWINCH-aware programs) track the window.
    resize(cols, rows) {
      con.resize(cols, rows);
    },
    kill() {
      if (killed) return;
      killed = true;
      // Detach the renderer BEFORE onKill: the kernel-service hook writes
      // Ctrl-D, which makes inittab respawn a shell on this hvc — those bytes
      // must land in the console's backlog (cleared by the hook's reset()),
      // not in a renderer that's about to be disposed (#crash on close).
      for (const off of unsubs) off();
      unsubs.clear();
      listeners.clear();
      hooks.onKill?.();
    },
    // Server-side hangup (kernel Shut Down with this tab still open): deliver a
    // final notice to the attached renderer(s), then kill. The tab stays open
    // showing the message — like a dropped ssh session — input goes nowhere.
    hangup(text = "\r\n\x1b[33m[Linux has shut down]\x1b[0m\r\n") {
      if (killed) return;
      const bytes = new TextEncoder().encode(text);
      for (const cb of listeners) cb(bytes);
      this.kill();
    },
  };
}
