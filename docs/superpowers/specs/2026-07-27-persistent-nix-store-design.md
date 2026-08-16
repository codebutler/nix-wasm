# Persistent `/nix` — installed NixOS (seed from ISO, updates via Nix)

> Canonical design promoted from [nix-wasm#177](https://github.com/codebutler/nix-wasm/issues/177).
> pc companion: codebutler/pc `docs/superpowers/specs/2026-07-27-linux-nixos-persistence-design.md`.

**Date:** 2026-07-27  
**Status:** Implementation in progress (G2–G6 landed on `cursor/linux-nixos-persistence-eab8`; G1 smoke pending CI — Node worker/Atomics hang in some agents)  
**Repos:** `nix-wasm` (guest, seed image, init, engine blk) + `pc` (state disk flush/store, host bootloader)  
**Supersedes (for persistence):** live-media “squashfs lower + durable overlay upper” brainstorming. That path is rejected.  
**Builds on:** #43 (squashfs-on-virtio-blk), channel `linux-image` (pc#315), Cachix-over-Wisp substitution, `userspace/bootstrap.nix` system-profile activation.

---

## 0. Motivation

Today the guest is a **NixOS live image**:

- `base.squashfs` on `/dev/vda` → overlay lower for `/nix`
- ramfs upper (`/run/nix-upper`) — `bootstrap.nix` says so explicitly because “NOMMU has no block-backed writable fs”
- `nix-env` / profile installs survive only until Shut Down
- Host “updates” mean republishing `linux.iso` via the channel

That is the right delivery shape for an **installer**. It is the wrong shape for an **installed system**. Real NixOS does not keep rebasing a squashfs under a sticky upper and inventing compatibility epochs. It:

1. Installs a store onto a disk once  
2. Boots generations from that store  
3. Updates by substituting/building into `/nix` and switching the profile  

We want that.

---

## 1. Locked decisions

| # | Decision |
|---|---|
| D1 | **Model = installed NixOS.** Durable `/nix` on a RW disk. System = profile generations. Updates = Nix (Cachix / `nix-env` / `nix profile` / later `nixos-rebuild`). |
| D2 | **`linux.iso` is installer + recovery only.** It carries the initial seed (kernel, initramfs, seed store image). It is **not** the ongoing lowerdir of a running install. Day-to-day updates do **not** require a new ISO. |
| D3 | **First boot copies the seed out** onto the state disk; later boots mount the state disk’s `/nix` directly (no overlay on squashfs). |
| D4 | **Host JS is the bootloader.** After install, `vmlinux` / initramfs come from the **current system generation** on the state disk (mirrored into a small host-readable boot area), not from the ISO — same role as systemd-boot reading `/nix/var/nix/profiles/system`. |
| D5 | **ISO republish remains** for: brand-new installs, factory reset seed, and recovery when the state disk is missing/corrupt — **not** for routine package/system updates. |
| D6 | **Engine ABI** stays exact-match between vendored engine JS and the **kernel binary being booted**. Kernel packages in the store carry ABI metadata; the host refuses to boot a generation whose kernel ABI ≠ `ENGINE_ABI` (recovery path below). |
| D7 | **Reject** persistent overlay-upper-on-forever-squashfs, `compatEpoch` keep/reset-on-ISO, 9P-as-`/nix`, and single RW “classic VM root” that abandons Nix generations. |
| D8 | **pc** owns Machines-grade state-disk persistence (dirty journal, autosave, Shut Down flush-before-kill, `pagehide` cache, cross-tab lock, quota, Reset). **nix-wasm** owns RW blk, second device, seed→disk install, boot from generation, guest `/nix` layout. |

---

## 2. End-state topology

### Guest (after install)

```
/dev/vda  RO  seed squashfs from ISO     # used ONLY when state disk uninitialised
/dev/vdb  RW  state filesystem           # the installed system

Mounted when installed:
  /nix          ← from vdb (real store + db + profiles)   NO overlay on squashfs
  /home         ← from vdb (or bind from 9P host home — see §6)
  /var          ← from vdb (as needed)
  /mnt/pc       ← 9P host VFS (unchanged)
```

`/run/current-system` → `/nix/var/nix/profiles/system` → generation — unchanged activation story from today’s `bootstrap.nix` / `activate`.

### Host VFS (pc)

```
/Home/Library/Discs/linux.iso              # installer/recovery image (channel)
/Home/Library/Linux/
  state.json                               # installed?, generation, kernel ABI, boot mode, disk size
  disks/vdb                                # append-built stream of incremental CBHD dirties
  boot/                                    # host-readable bootloader mirror (see §4)
    current -> generation-N/
    generation-N/
      vmlinux.wasm
      initramfs.cpio.gz
      manifest.json                        # { system, kernelAbi, mode, nixosVersion?, … }
  home/                                    # optional host-visible home (§6)
```

### ISO contents (channel image — role change, not abandonment)

```
linux.iso
  vmlinux.wasm           # recovery / first-boot kernel (also the seed default)
  initramfs.cpio.gz      # installer init (seed copy + activate)
  base.squashfs          # SEED store closure (copied onto vdb once)
  manifest.json          # { version, minEngine, seedLabel, … }
```

`base.squashfs` remains the NixOS-native “whole store as one artifact” (#43). Its job after this design is **install media**, not live lowerdir.

---

## 3. Boot flows

### 3a. First boot / factory reset (no valid state disk)

1. pc ensures `linux.iso` (existing channel), creates empty `vdb` (quota-checked), boots kernel+initramfs **from the ISO**.  
2. Passes `vda` = seed squashfs, `vdb` = empty RW state disk.  
3. Installer init (`bootstrap` install mode):
   - `mkfs` on `vdb` (ext4 or the writable FS we enable — **gate G1**)  
   - mount seed RO, mount `vdb`  
   - **copy** seed `/nix` onto `vdb` (store + `var/nix` including `profiles/system` + nix db)  
   - create `/home`, `/var` as needed  
   - write install stamp  
   - activate system profile; hand off to `$sys/init` as today  
4. Host bootloader sync (§4): after first successful activate (or via a guest→host ctl), mirror current generation’s kernel/initrd into `/Home/Library/Linux/boot/`.  
5. Mark `state.json` installed.

Copy, not overlay: after this point the squashfs is irrelevant until reset.

### 3b. Normal boot (installed)

1. pc loads `state.json` + applies `disks/vdb` dirties onto the state image.  
2. **Bootloader:** read `/Home/Library/Linux/boot/current/{vmlinux.wasm,initramfs.cpio.gz}`; require both ABI and `mode` to match the selected MMU/NOMMU runtime.
3. Boot that kernel/initramfs with `vdb` attached; `vda` seed may be omitted or attached unused.  
4. Init sees install stamp → mount `vdb`’s `/nix` directly → `readlink` profile → `activate` → `exec $sys/init`.  
5. No squashfs overlay. No ramfs upper for `/nix`.

### 3c. Recovery boot

If bootloader mirror missing, kernel ABI mismatch, or `vdb` corrupt:

- Boot kernel+initramfs **from ISO** (recovery).  
- If `vdb` has a store but boot mirror stale: regenerate mirror from `/nix/var/nix/profiles/system` (guest helper or host offline reader — prefer guest one-shot).  
- If unrecoverable: offer **Reset Linux** (wipe `vdb`, re-run 3a with current ISO seed).

---

## 4. Host as bootloader (the non-negotiable NixOS piece)

On real NixOS, `nixos-rebuild boot` writes a generation and updates the bootloader. Here the “bootloader” is pc:

**Generation switch must update `/Home/Library/Linux/boot/`.**

Mechanism (pick one in implementation; both are NixOS-shaped):

1. **Preferred:** activation / a small `pc-bootloader` hook in the guest copies (or streams via `/Ctl` / vsock) the generation’s `kernel` + `initrd` out to the host boot mirror and flips `current`.  
2. **Acceptable:** host reads those files from the live guest via `/Linux` (ninepd) immediately after a successful switch, before Shut Down.

`state.json` records `{ generation, kernelAbi, systemPath }`. Next cold boot uses the mirror only (guest not running yet) — identical constraint to a real bootloader on EFI ESP.

**Rollback:** point `boot/current` at `generation-(N-1)` (UI + guest `rollback`), then reboot. Generations that remain in `/nix` stay GC roots until collected.

---

## 5. Updates — entirely Nix, not a new ISO

| User / publisher action | Path |
|---|---|
| Install a package | `nix-env -iA nixpkgs.…` / `nix profile install` → writes `/nix` on `vdb` → survives Shut Down |
| Upgrade installed packages | same, against Cachix / channel — **no ISO** |
| Ship a new base/system closure | **Push outputs (+ drvs as needed) to `nix-wasm.cachix.org`** (and channel expr). Users upgrade with Nix. |
| New kernel for existing installs | Kernel derivation in store → profile switch → bootloader mirror update → reboot |
| Brand-new user / Reset | Channel `linux.iso` seed copy (3a) |
| Engine JS ABI break | Deploy new pc engine; publish kernel built for that ABI to Cachix; users who can’t boot get recovery ISO path + upgrade or Reset |

**Channel `latest.json` ISO bumps are not the update mechanism for installed systems.** They refresh installer/recovery media. Optional UX: “Update Linux” in the tray runs the in-guest Nix upgrade (ensure online / Wisp), then offers reboot if the boot generation changed.

Deprecate the mental model “republish ISO to fix the live guest” for anything that can be a store path.

---

## 6. Home and host peek

- **Home** lives on `vdb` under `/home` (or `/root` for the single-user appliance — match whatever the toplevel already uses).  
- **Offline host peek:** bind or sync `/home` (or `/root`) to `/Home/Library/Linux/home` via existing 9P `/mnt/pc` so Filer works when Linux is down — same product need as before, but as a **bind of user data**, not as the persistence mechanism for `/nix`.  
- **Live peek of the whole system:** keep `/Linux` reverse 9P (`ninepd`) while running.  
- **No** offline ext4 parser required for v1.

---

## 7. State disk persistence on pc (Machines contract)

Reuse the product contract from Machines persistent disks — not CBHD-on-emulator-buffers blindly:

| Behavior | Requirement |
|---|---|
| Dirty journal | Engine RW `BlkDevice` for `vdb`; `saveDisk()` / apply-on-boot |
| Autosave | ~30s + debounce after blk IO |
| Shut Down | **flush disk, then kill kernel** (today’s `onQuit` does not flush) |
| `pagehide` | write last **cached** overlay immediately |
| Lock | `acquireResourceLock("cb.linux.state")` — one writer |
| Reset | delete `disks/vdb` + boot mirror (+ optional home); keep ISO; next start = install |
| Quota | `storageQuotaShortfall` before create/grow |

Backing: VFS/IDB Blobs (same conclusion as Machines). OPFS only if measured need.

**Do not** back the live block device with 9P (whole-record RMW). Journal is host-side over virtio-blk.

---

## 8. Engine / kernel gates (nix-wasm)

| Gate | What |
|---|---|
| **G1 Writable FS on virtio-blk** | Today bootstrap claims NOMMU has no block-backed writable FS (ramfs upper). Persistence **requires** enabling and proving a writable FS (ext4 or equivalent) on `/dev/vdb` for `/nix`. This is the critical path. |
| **G2 Second virtio-blk** | Device map is full (consoles etc.). Add `VW_DEV_BLK` instance #2 (or generalize), kernel transport registration, **`ENGINE_ABI` bump**. |
| **G3 RW `BlkDevice`** | Drop `F_RO` for state device; handle `T_OUT` (+ flush); dirty-sector journal + `saveDisk` API. Keep seed device RO. |
| **G4 Installer init** | `bootstrap.nix` grows install vs installed modes: copy seed → direct mount; remove forever-overlay path for installed systems. |
| **G5 Bootloader export** | Guest activation hook or ctl to publish kernel/initrd+manifest to host boot mirror. |
| **G6 Kernel in store** | System closure includes bootable `vmlinux.wasm` (+ initramfs) as generation artifacts the bootloader can export — NixOS-shaped `system.build.kernel` analogue. |

Until G1–G3 land, there is no honest “installed NixOS.” Do not ship a half-overlay interim as persistence.

---

## 9. What happens to the channel / ISO

Keep `publish-linux-channel` + `.#linux-image`, with clarified semantics:

| Artifact | Role after this design |
|---|---|
| `linux.iso` | Installer + recovery + factory-reset seed |
| `base.squashfs` inside ISO | Seed store copied once onto `vdb` |
| Cachix `nix-wasm` | **Primary update channel** for installed systems |
| `latest.json` | Points at newest **installer**; not “please rebase your overlay” |
| `minEngine` / `ENGINE_ABI` | Guard on whatever kernel binary is about to boot (ISO or boot mirror) |
| generation manifest `mode` | Prevent an MMU generation mirror from booting as NOMMU, or the reverse |

Docs/runbooks change from “republish guest to ship fixes” → “push to Cachix for installed systems; republish ISO for seed/recovery/ABI install media.”

---

## 10. Definition of done

1. First launch installs seed from ISO onto `vdb`; subsequent boots do not use squashfs as `/nix` lower.  
2. `nix-env` / `nix profile` / store db changes survive Shut Down + relaunch.  
3. Upgrading a package via Cachix requires **no** ISO download.  
4. Switching a generation updates the host boot mirror; reboot runs the new kernel/initrd when those changed.  
5. Rollback to a previous generation works via boot mirror + profile.  
6. Reset Linux re-seeds from current ISO; user data policy explicit (wipe home or keep).  
7. Reload mid-session loses ≤ one autosave window.  
8. Second tab cannot dual-write `vdb`.  
9. Offline: home visible under `/Home/Library/Linux/home`; live: full tree at `/Linux`.  
10. No `compatEpoch` / overlay-keep policy — generations and GC are the contract.

---

## 11. Ownership split

| Work | Repo |
|---|---|
| G1–G6, installer init, seed layout, kernel-in-closure, ABI bump, channel seed semantics | **nix-wasm** |
| `linux-store`, bootloader mirror I/O, flush/lock/quota/UI, `bootNixSystem({ stateDisk })`, Shut Down order | **pc** |
| Cachix publish of system/kernel updates | **nix-wasm** CI |
| ISO publish as installer | **nix-wasm** `publish-linux-channel` (role clarified) |

---

## 12. Explicit non-goals

- Persistent overlay upper on a forever-live squashfs  
- ISO-as-update for installed systems  
- 9P-backed `/nix`  
- Hibernation / full RAM snapshot as a substitute for disk persistence  
- Offline host mount of the whole ext4 system image in JS (v1)

---

## 13. Relationship to prior art in-tree

- **#43 squashfs design** — still correct for *seed / live installer* packaging; wrong as the permanent runtime `/nix` after install. This spec is the install step that design never took.  
- **`bootstrap.nix` overlay+ramfs** — becomes install-only / busybox-fallback; installed path mounts `vdb`.  
- **pc channel (`linux-channel.ts`)** — stays; semantics shift to installer/recovery.  
- **Machines disks** — product contract for flush/lock/reset only.  
- **N2.5 “OPFS persist store paths”** — superseded by disk-backed `/nix` (NixOS-native). OPFS is not the architecture.
