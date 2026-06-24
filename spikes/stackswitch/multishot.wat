(module
  (type $ft (func))
  (type $ct (cont $ft))
  (tag $yield)
  (func $coro (suspend $yield))
  (elem declare func $coro)
  (func (export "test") (result i32)
    (local $k (ref null $ct))
    (local.set $k (cont.new $ct (ref.func $coro)))
    ;; first resume: coro suspends $yield -> handler block receives the new continuation
    (block $h (result (ref $ct))
      (resume $ct (on $yield $h) (local.get $k))
      (return (i32.const 99))            ;; coro didn't suspend (unexpected)
    )
    (drop)                                ;; drop the NEW continuation from the suspend
    ;; SECOND resume of the ORIGINAL $k (already consumed). one-shot => trap; multi-shot => runs.
    (block $h2 (result (ref $ct))
      (resume $ct (on $yield $h2) (local.get $k))
      (return (i32.const 1))             ;; reached only if second resume DID NOT trap
    )
    (drop)
    (return (i32.const 2))               ;; second resume suspended again (multi-shot!)
  )
)
