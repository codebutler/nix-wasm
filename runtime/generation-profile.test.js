import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repo = resolve(import.meta.dir, "..");
const bootloader = join(repo, "userspace/yore-bootloader.sh");
const systemTool = join(repo, "userspace/yore-system.sh");

describe("installed system generations", () => {
  let root;
  let profiles;
  let store;
  let hostLinux;
  let currentSystem;
  let fakeNixEnv;
  let env;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yore-generations-"));
    profiles = join(root, "profiles");
    store = join(root, "store");
    hostLinux = join(root, "host-linux");
    currentSystem = join(root, "current-system");
    fakeNixEnv = join(root, "nix-env");
    mkdirSync(profiles, { recursive: true });
    mkdirSync(store, { recursive: true });
    // The product explicitly prepares boot/ before enabling large guest exports.
    // A Linux/home-only tree is intentionally not enough (the boot smoke uses it
    // to prove offline home without copying 50+ MiB of generation artifacts).
    mkdirSync(join(hostLinux, "boot"), { recursive: true });

    writeFileSync(
      fakeNixEnv,
      `#!/bin/sh
set -e
profile=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) profile=$2; shift 2 ;;
    --set)
      candidate=$2
      max=0
      for p in "${profiles}"/system-*-link; do
        [ -L "$p" ] || continue
        n=\${p##*system-}; n=\${n%-link}; [ "$n" -gt "$max" ] && max=$n
      done
      next=$((max + 1))
      ln -s "$candidate" "${profiles}/system-$next-link"
      ln -sfn "system-$next-link" "$profile"
      exit 0 ;;
    --rollback)
      active=$(readlink "$profile"); n=\${active#system-}; n=\${n%-link}
      prev=$((n - 1))
      while [ "$prev" -gt 0 ] && [ ! -L "${profiles}/system-$prev-link" ]; do prev=$((prev - 1)); done
      [ "$prev" -gt 0 ] && ln -sfn "system-$prev-link" "$profile"
      exit 0 ;;
    --list-generations) exit 0 ;;
    *) shift ;;
  esac
done
exit 2
`,
    );
    chmodSync(fakeNixEnv, 0o755);
    env = {
      ...process.env,
      YORE_SYSTEM_PROFILE: join(profiles, "system"),
      YORE_STORE_PREFIX: store,
      YORE_CURRENT_SYSTEM: currentSystem,
      YORE_NIX_ENV: fakeNixEnv,
      YORE_HOST_LINUX: hostLinux,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeSystem(name, mode = "mmu", abi = 14) {
    const sys = join(store, name);
    mkdirSync(join(sys, "boot"), { recursive: true });
    writeFileSync(join(sys, "init"), "#!/bin/sh\n");
    chmodSync(join(sys, "init"), 0o755);
    writeFileSync(join(sys, "boot/vmlinux.wasm"), `kernel-${name}`);
    writeFileSync(join(sys, "boot/initramfs.cpio.gz"), `initrd-${name}`);
    writeFileSync(
      join(sys, "boot/manifest.json"),
      JSON.stringify({ kernelAbi: abi, system: sys, mode }),
    );
    writeFileSync(join(sys, "activate"), `#!/bin/sh\nexec sh '${bootloader}' "$1"\n`);
    return sys;
  }

  function run(script, args) {
    return spawnSync("sh", [script, ...args], { env, encoding: "utf8" });
  }

  const waitFor = async (predicate, timeout = 5_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for bootloader state");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  test("an offline-home-only host tree does not enable large boot exports", () => {
    rmSync(join(hostLinux, "boot"), { recursive: true, force: true });
    mkdirSync(join(hostLinux, "home"), { recursive: true });
    const sys1 = makeSystem("system-one");
    symlinkSync(sys1, join(profiles, "system-1-link"));
    symlinkSync("system-1-link", join(profiles, "system"));

    const exported = run(bootloader, [sys1]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(existsSync(join(hostLinux, "boot"))).toBe(false);
  });

  test("switch exports a numbered mirror and rollback restores profile plus boot files", () => {
    const sys1 = makeSystem("system-one");
    const sys2 = makeSystem("system-two");
    symlinkSync(sys1, join(profiles, "system-1-link"));
    symlinkSync("system-1-link", join(profiles, "system"));
    symlinkSync(sys1, currentSystem);

    const seed = run(bootloader, [sys1]);
    expect(seed.status, seed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(hostLinux, "boot/current/manifest.json"), "utf8"))).toEqual(
      {
        kernelAbi: 14,
        generation: 1,
        system: sys1,
        mode: "mmu",
      },
    );

    const switched = run(systemTool, ["switch", sys2]);
    expect(switched.status, switched.stderr).toBe(0);
    expect(readlinkSync(join(profiles, "system"))).toBe("system-2-link");
    expect(readFileSync(join(hostLinux, "boot/generation-2/vmlinux.wasm"), "utf8")).toBe(
      "kernel-system-two",
    );
    expect(existsSync(join(hostLinux, "boot/current/vmlinux.wasm"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(hostLinux, "boot/current/manifest.json"), "utf8")).generation,
    ).toBe(2);
    expect(readFileSync(join(hostLinux, "boot/generation-1/vmlinux.wasm"), "utf8")).toBe(
      "kernel-system-one",
    );

    const rolled = run(systemTool, ["rollback"]);
    expect(rolled.status, rolled.stderr).toBe(0);
    expect(readlinkSync(join(profiles, "system"))).toBe("system-1-link");
    expect(readFileSync(join(hostLinux, "boot/generation-1/vmlinux.wasm"), "utf8")).toBe(
      "kernel-system-one",
    );
    expect(
      JSON.parse(readFileSync(join(hostLinux, "boot/current/manifest.json"), "utf8")).generation,
    ).toBe(1);
    expect(readFileSync(join(hostLinux, "boot/generation-2/vmlinux.wasm"), "utf8")).toBe(
      "kernel-system-two",
    );
  });

  test("a capable host releases activation only after acknowledging the durable generation", async () => {
    const sys1 = makeSystem("system-one", "nommu");
    symlinkSync(sys1, join(profiles, "system-1-link"));
    symlinkSync("system-1-link", join(profiles, "system"));
    writeFileSync(
      join(hostLinux, "boot/host-capabilities.json"),
      JSON.stringify({ durableBootCommit: 1 }),
    );

    const child = spawn("sh", [bootloader, sys1], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const current = join(hostLinux, "boot/current");
    await waitFor(() => existsSync(join(current, "manifest.json")));
    expect(child.exitCode).toBeNull();
    writeFileSync(
      join(current, "committed.json"),
      JSON.stringify({
        kernelAbi: 14,
        generation: 1,
        system: sys1,
        mode: "nommu",
      }),
    );
    const status = await new Promise((resolve) => child.once("exit", resolve));
    expect(status, stderr).toBe(0);
  });

  test("switch refuses a different memory mode or engine ABI", () => {
    const sys1 = makeSystem("system-one");
    const wrongMode = makeSystem("system-nommu", "nommu", 14);
    const wrongAbi = makeSystem("system-new-abi", "mmu", 15);
    symlinkSync(sys1, join(profiles, "system-1-link"));
    symlinkSync("system-1-link", join(profiles, "system"));
    symlinkSync(sys1, currentSystem);

    expect(run(systemTool, ["switch", wrongMode]).status).not.toBe(0);
    expect(run(systemTool, ["switch", wrongAbi]).status).not.toBe(0);
    expect(readlinkSync(join(profiles, "system"))).toBe("system-1-link");
  });

  test("switch migrates a legacy direct system profile without losing generation one", () => {
    const sys1 = makeSystem("legacy-system");
    const sys2 = makeSystem("new-system");
    symlinkSync(sys1, join(profiles, "system"));
    symlinkSync(sys1, currentSystem);

    const switched = run(systemTool, ["switch", sys2]);
    expect(switched.status, switched.stderr).toBe(0);
    expect(readlinkSync(join(profiles, "system-1-link"))).toBe(sys1);
    expect(readlinkSync(join(profiles, "system"))).toBe("system-2-link");
    expect(readlinkSync(join(profiles, "system-2-link"))).toBe(sys2);
    expect(
      JSON.parse(readFileSync(join(hostLinux, "boot/current/manifest.json"), "utf8")),
    ).toMatchObject({ generation: 2, system: sys2 });
  });
});
