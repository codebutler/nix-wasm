// abi.js — the SINGLE SOURCE OF TRUTH for the guest↔engine ABI version (pc#315).
//
// Bump ENGINE_ABI by 1 ONLY on a real, incompatible change to the
// kernel/guest ↔ engine-JS contract (exec ABI, syscall/loader stubs, the
// virtio/9P device models). The published guest image (`.#linux-image`) stamps
// THIS number as its `manifest.json` + `latest.json` `minEngine`.
//
// The image and the engine must speak the EXACT SAME ABI. Every bump below is an
// incompatible change, so there is NO forward/backward compatibility — a newer
// engine does not run an older image any more than an older engine runs a newer
// one (e.g. ABI 8's MMU-native fork rewrote the exec run loop, so an ABI-10
// engine crashes an ABI-7 image mid-boot). pc enforces an EXACT match and reports
// the stale side: image `minEngine` > engine ABI → "reload pc"; image `minEngine`
// < engine ABI → "the Linux image is out of date, rebuild it". `minEngine` names
// the exact engine an image requires, NOT a floor — always ship a matching engine
// and image together.
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
//
// 11 (#145: guest audio): the virtio device set grew virtio-snd — a new device
// at host index 6 (VW_DEV_SND, the previously-unused slot between the 9P
// channels and vsock), served by runtime/virtio/snd-device.js (controlq/eventq/
// txq/rxq, one s16/48kHz playback stream) and drained on the main thread via
// the virtiosnd_notify worker→main forward. A kernel with CONFIG_SND_VIRTIO
// probes device 6 at boot; an old engine answers "unknown device index 6" (no
// features/config/queue service), the driver's control requests time out, and
// probe fails — /dev/snd never appears and ALSA userspace breaks: bump.
//
// NOT-A-BUMP (#175 exec-collapse trap): the engine's wasm_user_mode_tail now
// feature-detects a `wasm_collapse` KERNEL export and, when present, collapses the
// post-exec user stack via that export's GENUINE wasm trap (uncatchable by user
// catch_all) instead of a host JS throw (which nix's fork child swallowed → #175
// SIGSEGV). `wasm_collapse` is added ONLY by patches/kernel/0026 (mmu-fork
// kernels), so the SHIPPED NOMMU `.#kernel` / `.#linux-image` does NOT export it
// and keeps the byte-identical JS-throw path — the shipped image's contract is
// unchanged. DEFERRED OBLIGATION: if the MMU/fork guest ever becomes the
// published channel image (`.#linux-image` switches to a wasm_collapse kernel),
// THAT is an incompatible exec-ABI change and MUST bump ENGINE_ABI.
// NOT-A-BUMP (#179 exec-reject): wasm_load_executable now RETURNS a status
// (0 = loaded, nonzero = the host cannot run this image) and the kernel's
// start_thread kills just the execing task. NO import is added or removed —
// only an existing import's RESULT type moves — so the wire stays compatible
// in BOTH directions (see kernel.nix postPatch).
//
// 12 (#177: installed NixOS persistence): second virtio-blk at host index 1
// (VW_DEV_BLK_STATE — reclaims the echo self-test slot) serving the RW state
// disk (/dev/vdb), plus RW BlkDevice (T_OUT + dirty-sector journal + saveDisk).
// Seed squashfs stays RO at VW_DEV_BLK=3 (/dev/vda). An old engine answers
// "unknown device index 1" (or still serves EchoDevice) and the guest's
// installer/installed bootstrap can't mount the state disk: bump.
//
// 13 (#903: finish the Yore rename): the root 9P device mount tag changed from
// `pcroot` to `yoreroot`, alongside the guest mount moving from `/mnt/pc` to
// `/mnt/yore`. An old engine exposes only the retired tag, so the renamed guest
// cannot mount YoreFS; an old image likewise cannot find the new engine tag.
//
// 14 (#216 Phase 3: software-MMU/fork guest becomes the published default):
// the channel image now exports `wasm_collapse`, and the engine's exec tail must
// use that uncatchable wasm trap to collapse a fork child's asyncified stack.
// The old NOMMU image used the catchable host-JS throw path. Shipping either
// side without the other breaks fork+exec, so the coordinated engine/image
// rollout requires an exact-match bump.
export const ENGINE_ABI = 14;
