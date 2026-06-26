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
// 5 (#83): the console moved off the bespoke hvc_wasm backend onto stock
// virtio-console — 8 featureless single-port devices (one synchronous hvc line
// each, host idx 8..15), NOT one multiport device (its async control-vq port
// handshake races init to death on single-CPU wasm boot). The kernel↔engine
// contract changed incompatibly — the wasm_driver_hvc_put/get/winsize host
// imports are gone, replaced by per-console virtio receiveq/transmitq vrings the
// host drives via runtime/virtio/console-device.js.
export const ENGINE_ABI = 5;
