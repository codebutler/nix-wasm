# Dedicated CI runner

The Nix build, boot tests, previews, and channel publisher use a repository-scoped
GitHub Actions runner with these labels:

```text
self-hosted, linux, X64, nix-wasm
```

Register an **x86_64 Linux** runner for `codebutler/nix-wasm` with the custom
`nix-wasm` label. Use at least 16 vCPU, 32 GiB RAM, and 200 GiB free disk for a
cold build. Two runners allow the `guest-clang` and `kernel` matrix jobs to build
in parallel; one runner runs them sequentially. Set up the runner as an ephemeral
or otherwise isolated service following GitHub's self-hosted runner instructions.
The `cachix/install-nix-action` and `cachix/cachix-action` steps install Nix and
configure the cache for each job; the publishing workflow also installs Node 22,
Bun, and rclone.

The pc repository's `lima` runner is **ARM64, 4 vCPU, 6 GiB RAM**. It cannot use
the x86_64 Nix store paths built by this repo's CI, and it does not have enough
resources for the from-source LLVM builds. Do not register that VM with the
`nix-wasm` label. A label-only change to those jobs would leave the release
blocked or build a different closure.

This repository is public. PR jobs continue to use managed runners; the
dedicated runner is selected only for push and maintainer-dispatched workflows.
Run the dedicated machine only while needed and avoid reusing its workspace
across unrelated repositories.

Once the dedicated runner is online, rerun `nix-wasm.yml` on `master` and wait
for the `artifacts` job to finish pushing its exact store paths to Cachix. Then
run `publish-linux-channel.yml` with `dry_run: true` before the live run. Keep
`allow_unpublished: false`: the publisher's provenance gate checks the CI-built
paths before flipping the channel pointer.
