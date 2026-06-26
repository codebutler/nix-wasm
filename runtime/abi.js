// abi.js — the SINGLE SOURCE OF TRUTH for the guest↔engine ABI version (pc#315).
//
// Bump ENGINE_ABI by 1 ONLY on a real, incompatible change to the
// kernel/guest ↔ engine-JS contract (exec ABI, syscall/loader stubs, the
// virtio/9P device models). The published guest image (`.#linux-image`) stamps
// THIS number as its `manifest.json` + `latest.json` `minEngine`. pc refuses to
// boot an image whose `minEngine` exceeds the vendored engine's ENGINE_ABI,
// surfacing a "reload pc" message instead of a silent boot crash.
//
// `userspace/linux-image.nix` parses this exact line, so keep the form
// `export const ENGINE_ABI = <int>;` on one line.
//
// 5 (#83): the console moved off the bespoke hvc_wasm backend onto the stock
// MULTIPORT virtio-console. The kernel↔engine contract changed incompatibly —
// the wasm_driver_hvc_put/get/winsize host imports are gone, the console device
// gained the multiport control-plane + per-port queues, and the transport's
// per-device vq cap (VIRTIO_WASM_MAX_VQS) + the cross-worker MAX_QS grew to 18.
export const ENGINE_ABI = 5;
