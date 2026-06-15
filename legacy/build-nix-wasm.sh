#!/usr/bin/env bash
# build-nix-wasm.sh — cross-compile Nix 2.34.7 to the wasm32-linux-musl guest
# ABI and link it into a single `nix.wasm` that runs in-guest (issue #139).
#
# This is the reproducible form of the milestone documented in README.md:
# Nix's C++ is built with stock clang-21 against the linux-wasm musl sysroot +
# the Layer-1/Layer-2 deps from ../nixdeps/build-sysroot.sh, then ALL object
# files are linked directly into one executable (meson's `-r` prelink can't emit
# wasm TLS relocations — see README.md "How it's built").
#
#   Reproduce:
#     # 1. build the dep sysroot (once):
#     LW_INSTALL=/path/to/linux-wasm/install \
#       ../nixdeps/build-sysroot.sh
#     # 2. build nix.wasm against it:
#     LW_INSTALL=/path/to/linux-wasm/install \
#       SYSROOT=/path/to/nixdeps/out/sysroot \
#       scripts/linux-demo/nixbuild/build-nix-wasm.sh
#
# Produces $OUT/nix.wasm (default ./out/nix.wasm), stripped, ~16 MB at -O2.
# Copy it to vendor/linux-wasm/nix.wasm to ship (the kernel-service guest-tools
# 9P export serves it to /opt/bin/nix in-guest).
#
# Toolchain note: the C++ must be clang-21 (libc++-18's `constexpr std::string`
# and wasm-exceptions handling differ); set REAL_LLVM21 to a clang-21 bindir.
# The musl sysroot + cxx runtime + kernel headers come from $LW_INSTALL exactly
# as ../nixdeps/build-sysroot.sh consumes them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
LW_INSTALL="${LW_INSTALL:-/root/lw-build/ws/install}"
MUSL="${MUSL:-$LW_INSTALL/musl-$VARIANT}"
KHDR="${KHDR:-$LW_INSTALL/busybox-kernel-headers-$VARIANT}"
CXXRT="${CXXRT:-$LW_INSTALL/cxx-$VARIANT}"
SYSROOT="${SYSROOT:-$HERE/../nixdeps/out/sysroot}"

# clang-21 for the C++ (kernel LLVM is patched but newer than apt; either works
# as long as it's >= 21). The C wrapper can use apt clang (user-ABI only).
CLANG21="${CLANG21:-$(command -v clang-21 || echo /usr/bin/clang-21)}"
CLANG_C="${CLANG_C:-$(command -v clang-18 || command -v clang || echo /usr/bin/clang)}"
WASMLD="${WASMLD:-$(command -v wasm-ld-21 || command -v wasm-ld || echo /usr/bin/wasm-ld-21)}"
AR="${AR:-$(command -v llvm-ar-21 || command -v llvm-ar || echo /usr/bin/llvm-ar)}"
STRIP="${STRIP:-$(command -v llvm-strip-21 || command -v llvm-strip || echo /usr/bin/llvm-strip)}"
RANLIB="${RANLIB:-$(command -v llvm-ranlib-21 || command -v llvm-ranlib || echo /usr/bin/llvm-ranlib)}"

OUT="${OUT:-$HERE/out}"
SRC="${SRC:-$OUT/src}"
WRAP="$OUT/wrap"
NIX_VERSION="2.34.7"
# NixOS/nix git tag for the source. The wasm32 port patch (patches/) was
# generated against this tag's tree.
NIX_GIT="https://github.com/NixOS/nix.git"
JOBS="${JOBS:-4}"

die() { printf '\033[1;31m[nixbuild]\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '\033[1;36m[nixbuild]\033[0m %s\n' "$*"; }

[ -x "$CLANG21" ] || die "clang-21 not found ($CLANG21) — set CLANG21"
[ -f "$MUSL/lib/crt1.o" ] || die "musl sysroot not found at \$MUSL ($MUSL) — set LW_INSTALL"
[ -f "$SYSROOT/lib/libsqlite3.a" ] || die "dep sysroot not found at \$SYSROOT ($SYSROOT) — run ../nixdeps/build-sysroot.sh first"
[ -d "$CXXRT/include/c++/v1" ] || die "C++ runtime not found at \$CXXRT ($CXXRT)"
command -v meson >/dev/null || die "meson not found (apt install meson)"
command -v ninja >/dev/null || die "ninja not found (apt install ninja-build)"

mkdir -p "$SRC" "$WRAP" "$WRAP/pkgconfig" "$WRAP/bin" "$OUT"

# --- generate the toolchain wrappers (parameterized — no hardcoded paths) ----
# Shared compile flags for the guest ABI (atomics+bulk-memory, wasm exceptions).
CXX_COMMON="--ld-path=$WASMLD --target=wasm32-unknown-unknown -fPIC \
  --sysroot=$MUSL -isystem $KHDR -D__linux__ -D_GNU_SOURCE -matomics -mbulk-memory \
  -fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ -fvisibility=hidden -fvisibility-inlines-hidden \
  -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS \
  -nostdinc++ -isystem $CXXRT/include/c++/v1 -I$SYSROOT/include"
CXX_WARN="-Wno-error -Wno-error=suggest-override -Wno-error=switch -Wno-error=switch-enum \
  -Wno-error=undef -Wno-error=unused-result -Wno-error=sign-compare -Wno-error=return-type \
  -Wno-error=non-virtual-dtor -Wno-error=c99-designator"

# C++ wrapper: meson's link_whole uses `-r` (relocatable prelink) which must NOT
# carry the dylink/shared-memory flags (wasm-ld rejects `-r` + --shared-memory),
# so the wrapper drops them when it sees `-r`. The non-`-r` branch is the real
# executable link (used by our direct link below).
cat > "$WRAP/bin/wcxx" <<EOF
#!/bin/bash
reloc=
for a in "\$@"; do [ "\$a" = "-r" ] && reloc=1; done
if [ -n "\$reloc" ]; then
  exec "$CLANG21" $CXX_COMMON "\$@" -nostdlib++ -L$CXXRT/lib -lunwind -lc++abi $CXX_WARN
else
  exec "$CLANG21" $CXX_COMMON "\$@" \\
    -nostdlib++ -L$CXXRT/lib -lc++ -lc++abi -lunwind -L$SYSROOT/lib \\
    -Wl,-shared -Wl,-Bsymbolic \\
    -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296 \\
    -Wl,--import-table -Wl,--allow-undefined -Wl,--export=_start \\
    -Wl,--export-if-defined=__wasm_apply_data_relocs -Wl,--export-if-defined=__wasm_call_ctors \\
    -Wl,--export-if-defined=__set_tls_base -Wl,--export-if-defined=__libc_clone_callback \\
    -Wl,--export-if-defined=__libc_handle_signal $CXX_WARN
fi
EOF

# C wrapper (a handful of Nix's deps probe a C compiler).
cat > "$WRAP/bin/wcc" <<EOF
#!/bin/bash
exec "$CLANG_C" --target=wasm32-unknown-unknown -fPIC --sysroot=$MUSL -isystem $KHDR \\
  -D__linux__ -D_GNU_SOURCE -matomics -mbulk-memory -I$SYSROOT/include "\$@" \\
  -Wl,-shared -Wl,-Bsymbolic -Wl,--no-entry -Wl,--export-all \\
  -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296 \\
  -Wl,--import-undefined -Wl,--import-table -Wl,--no-merge-data-segments \\
  -Wl,--export-if-defined=__set_tls_base -Wl,--export-if-defined=__libc_handle_signal \\
  -L$SYSROOT/lib
EOF
chmod +x "$WRAP/bin/wcxx" "$WRAP/bin/wcc"

# --- meson cross file ---------------------------------------------------------
cat > "$WRAP/wasm32-cross.ini" <<EOF
[binaries]
c = '$WRAP/bin/wcc'
cpp = '$WRAP/bin/wcxx'
ar = '$AR'
strip = '$STRIP'
ranlib = '$RANLIB'
pkg-config = '$(command -v pkgconf || command -v pkg-config)'

[host_machine]
system = 'linux'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'

[properties]
needs_exe_wrapper = true

[built-in options]
cpp_std = 'c++23'
EOF

# --- pkg-config files for the cross deps (meson resolves these by name) -------
# Some Version: fields are spoofed UP to satisfy Nix's meson `version: '>=…'`
# minimums where the real release is older but ABI-compatible for our use
# (curl 8.11 reported as 8.17; blake3 1.5 as 1.8; git2 stubs as 1.9).
gen_pc() { # name version "libs"
  cat > "$WRAP/pkgconfig/$1.pc" <<PC
prefix=$SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: $1
Description: $1 (wasm32 nix port)
Version: $2
Libs: -L\${libdir} $3
Cflags: -I\${includedir}
PC
}
gen_pc sqlite3          3.45.1 "-lsqlite3"
gen_pc libsodium        1.0.19 "-lsodium"
gen_pc bzip2            1.0.8  "-lbz2"
gen_pc libcrypto        3.3.2  "-lcrypto"
gen_pc libssl           3.3.2  "-lcrypto"
gen_pc openssl          3.3.2  "-lcrypto"
gen_pc libbrotlicommon  1.1.0  "-lbrotlicommon"
gen_pc libbrotlidec     1.1.0  "-lbrotlidec -lbrotlicommon"
gen_pc libbrotlienc     1.1.0  "-lbrotlienc -lbrotlicommon"
gen_pc libarchive       3.7.4  "-larchive -lz -lbz2 -llzma"
gen_pc libblake3        1.8.2  "-lblake3"
gen_pc libeditline      1.17.1 "-leditline"
gen_pc libcurl          8.17.0 "-lcurl"
gen_pc libgit2          1.9.0  "-lgit2"
gen_pc nlohmann_json    3.11.3 ""
export PKG_CONFIG_LIBDIR="$WRAP/pkgconfig"
export PKG_CONFIG_PATH="$WRAP/pkgconfig"

# --- fetch + patch Nix source -------------------------------------------------
NIXSRC="${NIXSRC:-$SRC/nix-$NIX_VERSION}"
if [ ! -d "$NIXSRC/src" ]; then
  note "clone Nix $NIX_VERSION"
  rm -rf "$NIXSRC"
  git clone --depth 1 -b "$NIX_VERSION" "$NIX_GIT" "$NIXSRC" 2>/dev/null \
    || die "git clone failed (tag $NIX_VERSION)"
  ( cd "$NIXSRC"
    note "apply wasm32 port patch"
    git apply --whitespace=nowarn "$HERE/patches/nix-2.34.7-wasm32-port.patch" \
      || patch -p1 < "$HERE/patches/nix-2.34.7-wasm32-port.patch" \
      || die "port patch failed to apply" )
fi

# Symlink-mtime + close_range config fixes (#141). meson's cross feature probes
# mis-detect two things, breaking setWriteTime on symlinks (nix-env profiles,
# substituting symlink-bearing packages) and a close_range compile:
#   - HAVE_DECL_AT_SYMLINK_NOFOLLOW probes false (has_header_symbol fails in the
#     cross), so the working utimensat(AT_SYMLINK_NOFOLLOW) path is #if'd out and
#     nix THROWS on every symlink. AT_SYMLINK_NOFOLLOW IS declared in the guest
#     fcntl.h → force it on.
#   - close_range probes true (link test) but musl-wasm doesn't declare it → drop
#     it from the checks so the wasm port's syscall(SYS_close_range) path is used.
# Patch the meson SOURCE (idempotent) — a post-setup header edit gets clobbered
# when ninja regenerates the configure_file output.
UM="$NIXSRC/src/libutil/unix/meson.build"
sed -i "s/cxx.has_header_symbol('fcntl.h', 'AT_SYMLINK_NOFOLLOW').to_int()/1/" "$UM"
perl -0777 -i -pe "s/\s*\[\s*'close_range',\s*'[^']*',\s*\],//s" "$UM"

# --- stub libraries (git2 + misc) into the sysroot if absent ------------------
if [ ! -f "$SYSROOT/lib/libgit2.a" ]; then
  note "build libgit2.a (stubs)"
  "$CLANG_C" --target=wasm32-unknown-unknown -fPIC --sysroot="$MUSL" -idirafter /usr/include \
    -c "$HERE/git2-stubs.c" -o "$WRAP/git2-stubs.o"
  "$AR" rcs "$SYSROOT/lib/libgit2.a" "$WRAP/git2-stubs.o"
fi
note "build libmiscstub.a"
"$CLANG_C" --target=wasm32-unknown-unknown -fPIC --sysroot="$MUSL" \
  -c "$HERE/misc-stubs.c" -o "$WRAP/misc-stubs.o"
"$AR" rcs "$SYSROOT/lib/libmiscstub.a" "$WRAP/misc-stubs.o"

# --- meson configure + compile ------------------------------------------------
BUILD="$NIXSRC/build-wasm"
if [ ! -f "$BUILD/build.ninja" ]; then
  note "meson setup ($BUILD)"
  ( cd "$NIXSRC"
    meson setup build-wasm \
      --cross-file "$WRAP/wasm32-cross.ini" \
      -Dunit-tests=false -Ddoc-gen=false -Dbindings=false -Dbenchmarks=false -Djson-schema-checks=false \
      -Dlibexpr:gc=disabled -Dlibstore:seccomp-sandboxing=disabled \
      -Doptimization=2 -Ddebug=false >/dev/null )
fi

note "compile (ninja -k0 — the meson '-r' prelink steps fail as expected; only the .o matter)"
# -k0 keeps going past the prelink failures; the per-translation-unit .o we need
# all compile fine. Don't treat ninja's nonzero exit as fatal here.
( cd "$BUILD" && ninja -k0 >/dev/null 2>&1 || true )

# --- collect objects + direct link -------------------------------------------
# All Nix .o under the per-library object dirs + nix.p/, minus the C-API
# bindings and the meson prelink products (which carry no usable code for us).
# Newer meson defaults to default_library=shared, so the objects live in
# `libnix*.so.<ver>.p/` (plus the libnixexpr-parser `.a.p`); match both. The
# C-binding libs (libnix*c.so.*.p — the nix_api_* objects) are excluded.
OBJS="$OUT/nix-objs.txt"
( cd "$BUILD" && find src \
    \( -path '*/libnix*.so.*.p/*.o' -o -path '*/libnix*.a.p/*.o' -o -path 'src/nix/nix.p/*.o' \) \
    ! -path '*libnix*c.so.*' ! -name '*nix_api_*' ! -name '*prelink*' | sort ) > "$OBJS"
NOBJ=$(wc -l < "$OBJS")
[ "$NOBJ" -gt 250 ] || die "expected ~290 objects, found $NOBJ — did the compile fail?"
note "linking $NOBJ objects → nix.wasm"

( cd "$BUILD"
  "$WRAP/bin/wcxx" @"$OBJS" \
    -L"$SYSROOT/lib" \
    -lsqlite3 -lsodium -lbz2 -llzma -lz \
    -lbrotlienc -lbrotlidec -lbrotlicommon -larchive \
    -lcrypto -lssl -lblake3 -leditline -lboost_url \
    -lcurl -lgit2 -lmiscstub \
    -o "$OUT/nix.unstripped.wasm" )

"$STRIP" "$OUT/nix.unstripped.wasm" -o "$OUT/nix.wasm"
SZ=$(( $(stat -c%s "$OUT/nix.wasm") / 1024 / 1024 ))
note "nix.wasm built: ${SZ} MB ($OUT/nix.wasm)"
note "ship it:  cp $OUT/nix.wasm vendor/linux-wasm/nix.wasm"
