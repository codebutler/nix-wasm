# Dedicated CI runner

Trusted Nix builds, boot tests, Worker deploys, and the channel publisher use a repository-scoped
GitHub Actions runner with these labels:

```text
self-hosted, linux, ARM64, nix-wasm
```

Register a dedicated **ARM64 Linux Lima VM with VZ Rosetta enabled** for
`codebutler/nix-wasm` with the custom `nix-wasm` label. Nix is explicitly
configured for `x86_64-linux` in the workflows: Rosetta executes the x86 build
tools, and the resulting derivation and store paths match the x86 release cache.
The active pc runner remains a separate VM. Give this VM as much RAM and disk as
the host can spare; cold LLVM builds are resource intensive. One runner executes
the `guest-clang` and `kernel` matrix jobs sequentially. Set it up as an ephemeral
or otherwise isolated service following GitHub's self-hosted runner instructions.
Install Nix once in the Lima guest in single-user mode and retain its store
across trusted jobs. The workflows verify that its effective system is
`x86_64-linux`; `cachix/cachix-action` configures the cache. Managed PR jobs
continue to use `cachix/install-nix-action`. The publishing workflow also
installs Node 22, Bun, and rclone.
Install `unzip` in the VM before registering it: `oven-sh/setup-bun` needs it
for the boot-smoke job (minimal Ubuntu Lima images omit it).

The pc repository's `gha` Lima runner is **ARM64, 4 vCPU, 6 GiB RAM**. It lacks
Rosetta and cannot build this repository's x86_64 Nix store paths. Do not register
that VM with the `nix-wasm` label. A label-only change to these jobs would build
a different closure.

In the Lima VM, enable `vmOpts.vz.rosetta.enabled` and
`vmOpts.vz.rosetta.binfmt`; keep host mounts disabled. Verify
`/proc/sys/fs/binfmt_misc/rosetta` is enabled and that
`NIX_CONFIG=$'system = x86_64-linux\nextra-platforms = x86_64-linux' nix eval
--raw --impure --expr builtins.currentSystem` prints `x86_64-linux`. Build
`.#guest-clang` once before registering the runner to verify that a patched
compiler actually executes. A native ARM64 runner without these settings builds
different store paths.

This repository is public. PR jobs continue to use managed runners; the
dedicated runner is selected only for push and maintainer-dispatched workflows.
Run the dedicated machine only while needed and avoid reusing its workspace
across unrelated repositories.

Once the dedicated runner is online, rerun `nix-wasm.yml` on `master` and wait
for the `artifacts` job to finish pushing its exact store paths to Cachix. Then
run `publish-linux-channel.yml` with `dry_run: true` before the live run. Keep
`allow_unpublished: false`: the publisher's provenance gate checks the CI-built
paths before flipping the channel pointer.

Workflow and documentation edits can change the Linux image's source hash even
when `guest-clang` keeps the same derivation path. The workflow-only PR skips its
heavy matrix while still building the independent QA image; the push to master
forces the complete artifact build and Cachix upload.
