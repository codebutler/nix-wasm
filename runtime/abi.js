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
// ABI 5: virtwl VIRTIO_WL_VFD_FILL keymap protocol — a host→guest VFD_NEW may
// carry the FILL flag, making the kernel allocate guest-owned backing and copy
// streamed VFD_RECV chunks into it (so the wl_keyboard keymap fd is mmappable on
// NOMMU). Old engines lack the device-side fill streaming → keyboard won't work.
export const ENGINE_ABI = 5;
