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
// 5: virtwl VIRTIO_WL_VFD_FILL keymap protocol — a host→guest VFD_NEW may carry
// the FILL flag, making the kernel allocate guest-owned backing and copy streamed
// VFD_RECV chunks into it (so the wl_keyboard keymap fd is mmappable on NOMMU).
// Old engines lack the device-side fill streaming → keyboard won't work.
//
// 6 (#83): the console moved off the bespoke hvc_wasm backend onto stock
// virtio-console — 8 featureless single-port devices (one synchronous hvc line
// each, host idx 8..15), NOT one multiport device (its async control-vq port
// handshake races init to death on single-CPU wasm boot). The kernel↔engine
// contract changed incompatibly — the wasm_driver_hvc_put/get/winsize host
// imports are gone, replaced by per-console virtio receiveq/transmitq vrings the
// host drives via runtime/virtio/console-device.js.
//
// 7 (#83 follow-up: terminal resize): each single-port console now offers
// VIRTIO_CONSOLE_F_SIZE and the virtio_wasm transport grew a config-change
// interrupt — a SECOND per-console irq (VW_CONSOLE_CONFIG_IRQ_BASE + idx, 24..31)
// that the host raises on a winsize change, which the kernel turns into
// virtio_config_changed() → hvc_resize(). New host↔guest surface (the config irq
// + cols/rows in console config space), so an old engine can't drive a new
// image's resize path: bump.
//
// 8 (#126 Track C / #130): runtime dynamic linking — the user-instance import
// surface grew __wasm_dl_probe / __wasm_dlopen / __wasm_dlsym (runtime/dylink.js
// loader: side-module instantiation against the process Memory + shared table,
// GOT resolution, elem-slot dlsym per the fpcast rule), and clone/fork task
// creation now carries + replays the parent's side-module set (Track 0 §4). A
// guest musl built with the wasm dlopen port fails to instantiate on an old
// engine (missing env imports): bump.
//
// 9 (#126 Track A / #128): software MMU — the KERNEL import surface grew
// env.__mmu_set_pt_base (an MMU vmlinux's switch_mm/activate_mm hands over the
// incoming mm's page-table root; --import-undefined materializes the import
// only in CONFIG_MMU=y builds), the exec ABI grew a trailing pt_base arg on
// wasm_load_executable / wasm_create_and_run_task (the engine applies it to a
// softmmu-instrumented image's __mmu_pt_base global at instantiation), and
// clone task-creation messages carry pt_base. An MMU vmlinux fails to
// instantiate on an old engine (missing env import): bump. (NOMMU images
// remain compatible in both directions — extra trailing args are ignored by
// JS — but minEngine stamps conservatively from this constant as always.)
// 10 (#129 Track B: MMU-native fork): wasm_create_and_run_task grew a trailing
// fork_ctl arg (the asyncify fork control-buffer pointer, 0 = not a fork
// child), the user-instance import surface grew env.capture_stack (the musl
// 0010 _Fork seam), and the engine gained the fork orchestration — parent
// unwind → wasm_fork_current (kernel COW mm dup) → dual rewind on the SAME
// shared arena with per-process pt_base. A fork-enabled guest on an old engine
// would fail to instantiate (missing capture_stack) or _start() fork children
// from scratch: bump.
export const ENGINE_ABI = 10;
