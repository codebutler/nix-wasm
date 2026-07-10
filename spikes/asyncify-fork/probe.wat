;; Phase-2 Task-0 spike probe (hand-written, toolchain-free).
;;
;; Proves the asyncify double-return mechanism in isolation, before any musl/
;; kernel commitment (spec risk B3). $run calls the imported $do_fork once;
;; the harness orchestrates: unwind $run to the host, copy linear memory into a
;; second instance, then asyncify-REWIND both so the single $do_fork() call
;; returns TWICE — the parent's instance with a child token, the child's with 0.
;;
;; Independence is proven in LINEAR MEMORY (not a wasm global, which the byte
;; copy would not carry): a counter at mem[2048] is written pre-fork (500), then
;; each side adds its own (pid+1) post-fork. Separate WebAssembly.Memory objects
;; ⇒ parent and child diverge (543 vs 501).
;;
;; B3 assertion: the pre-fork marker (1111) must fire EXACTLY ONCE — the rewind
;; must land at the $do_fork call site, NOT re-run the function from the top.
(module
  (import "env" "memory" (memory 1))
  (import "host" "do_fork" (func $do_fork (result i32)))
  (import "host" "log" (func $log (param i32)))

  (func $run (export "run")
    (local $pid i32)

    ;; --- pre-fork (must execute exactly once, never replayed on rewind) ---
    (i32.store (i32.const 2048) (i32.const 500))
    (call $log (i32.const 1111))

    ;; --- the fork point ---
    (local.set $pid (call $do_fork))

    ;; --- post-fork (runs once per side, after each rewind) ---
    ;; mem[2048] += pid + 1
    (i32.store (i32.const 2048)
      (i32.add (i32.load (i32.const 2048))
               (i32.add (local.get $pid) (i32.const 1))))
    (call $log (local.get $pid))               ;; RET: parent=token, child=0
    (call $log (i32.load (i32.const 2048)))    ;; independence witness
  )
)
