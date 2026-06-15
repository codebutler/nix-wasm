#!/usr/bin/env bash
# build-sysroot.sh — cross-compile the Nix-port (#139) Layer-1 leaf dependencies
# to the wasm32-linux-musl guest ABI and assemble a `sysroot/{lib,include}` that
# later layers (Nix itself, Layer 2) link against. Each lib here is a LEAF (no
# heavy deps): the proven-in-guest set behind issue #139's dependency ladder.
#
# Toolchain: the SAME cross clang/wasm-ld + musl sysroot that builds the kernel
# and the guest clang (see vendor/linux-wasm/SOURCE.md). Stock apt clang-18 also
# works for these USER libs (the joelseverin linker-script patch is kernel-only).
# Point the env vars at a linux-wasm build tree:
#
#   Reproduce:  LW_INSTALL=/path/to/linux-wasm/install \
#               REAL_LLVM=$LW_INSTALL/llvm/bin \
#               scripts/linux-demo/nixdeps/build-sysroot.sh
#
# Produces $OUT/sysroot (default ./out/sysroot). Verify each lib in-guest with
# the matching exec-*.mjs harness (they exec a tiny round-trip test from the 9P
# VFS). The sysroot itself is NOT committed — it is reproducible from here.
#
# The link flags below carry the dylink ABI plus the two signal-handling
# exports (__set_tls_base / __libc_handle_signal) the host bridge calls on
# signal delivery — mandatory for any guest binary that may receive a signal.
# Layer-2 adds boost (iostreams+url), curl, git2 — TODO.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VARIANT="${LW_VARIANT:-wasm32_nommu}"
LW_INSTALL="${LW_INSTALL:-/root/lw-build/ws/install}"
export REAL_LLVM="${REAL_LLVM:-$LW_INSTALL/llvm/bin}"
MUSL="${MUSL:-$LW_INSTALL/musl-$VARIANT}"
KHDR="${KHDR:-$LW_INSTALL/busybox-kernel-headers-$VARIANT}"
CLANG="${CLANG:-$REAL_LLVM/clang}"
AR="${AR:-$REAL_LLVM/llvm-ar}"
RANLIB="${RANLIB:-$REAL_LLVM/llvm-ranlib}"
# C++ runtime (libc++/libc++abi/libunwind, static) for the one C++ dep, boost_url.
CXXRT="${CXXRT:-$LW_INSTALL/cxx-$VARIANT}"

OUT="${OUT:-$HERE/out}"
SRC="${SRC:-$OUT/src}"
SYSROOT="${SYSROOT:-$OUT/sysroot}"
WRAP="$OUT/wrap"
JOBS="${JOBS:-4}"

die() { printf '\033[1;31m[nixdeps]\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '\033[1;36m[nixdeps]\033[0m %s\n' "$*"; }
[ -x "$CLANG" ] || die "clang not found at \$CLANG ($CLANG) — set LW_INSTALL/REAL_LLVM (see vendor/linux-wasm/SOURCE.md)"
[ -f "$MUSL/lib/crt1.o" ] || die "musl sysroot not found at \$MUSL ($MUSL)"

mkdir -p "$SRC" "$SYSROOT/lib" "$SYSROOT/include" "$WRAP"

# Shared flags ---------------------------------------------------------------
CFLAGS_GUEST="--target=wasm32-unknown-unknown -fPIC --sysroot=$MUSL -D__linux__ -D_GNU_SOURCE -D_LARGEFILE64_SOURCE -matomics -mbulk-memory -O2"
# C++ compile command for boost_url (wasm exceptions, libc++ from $CXXRT).
CXX="$CLANG --target=wasm32-unknown-unknown -fPIC --sysroot=$MUSL -D__linux__ -D_GNU_SOURCE -matomics -mbulk-memory -O2 \
  -fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ -fvisibility=hidden -fvisibility-inlines-hidden \
  -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -std=c++17 -nostdinc++ -isystem $CXXRT/include/c++/v1"
# Dylink link flags for the autotools "can the CC link?" test (configure needs a
# successful link). --allow-undefined-file lists the kernel's host-import names.
cat > "$WRAP/allow.txt" <<'EOF'
__wasm_abort
__cpp_exception
logAPIs
__dlsym_time64
__cxa_thread_atexit_impl
__wasm_syscall_0
__wasm_syscall_1
__wasm_syscall_2
__wasm_syscall_3
__wasm_syscall_4
__wasm_syscall_5
__wasm_syscall_6
EOF
LDFLAGS_DYLINK="-Wl,-shared -Wl,-Bsymbolic -Wl,--no-entry -Wl,--export-all -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296 -Wl,--import-table -Wl,--no-merge-data-segments -Wl,--export-if-defined=__set_tls_base -Wl,--export-if-defined=__libc_handle_signal"

# Autotools CC wrapper: configure invokes it for both compile and the link test.
cat > "$WRAP/wcc" <<EOF
#!/bin/sh
# -Qunused-arguments: configure compiles objects with -c, where the trailing
# link flags are unused — silence the per-object warning noise (they ARE needed
# for the link step of configure's "can the CC produce executables?" test).
exec "$CLANG" -Qunused-arguments $CFLAGS_GUEST $LDFLAGS_DYLINK -Wl,--allow-undefined-file=$WRAP/allow.txt "\$@"
EOF
chmod +x "$WRAP/wcc"
ln -sf "$AR" "$WRAP/war" 2>/dev/null || cp "$AR" "$WRAP/war"
ln -sf "$RANLIB" "$WRAP/wranlib" 2>/dev/null || cp "$RANLIB" "$WRAP/wranlib"

# fetch <file> <url> <sha256> — cached download with integrity check.
fetch() {
  local f="$SRC/$1" url="$2" sha="$3"
  if [ ! -f "$f" ]; then note "fetch $1"; curl -fsSL "$url" -o "$f" || die "download failed: $url"; fi
  echo "$sha  $f" | sha256sum -c - >/dev/null 2>&1 || die "sha256 mismatch for $1 (got $(sha256sum "$f" | cut -d' ' -f1))"
}

cc_objs() { # compile a list of .c (in $PWD) to .o
  for f in "$@"; do $CLANG $CFLAGS_GUEST -I. -c "$f.c" -o "$f.o"; done
}

# --- deps -------------------------------------------------------------------
build_zlib() {
  fetch zlib-1.3.1.tar.gz https://zlib.net/fossils/zlib-1.3.1.tar.gz 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
  rm -rf "$SRC/zlib-1.3.1"; tar -C "$SRC" -xzf "$SRC/zlib-1.3.1.tar.gz"
  ( cd "$SRC/zlib-1.3.1"
    cc_objs adler32 crc32 deflate infback inffast inflate inftrees trees zutil compress uncompr gzclose gzlib gzread gzwrite
    "$AR" rcs "$SYSROOT/lib/libz.a" *.o
    cp zlib.h zconf.h "$SYSROOT/include/" )
  note "libz.a built"
}
build_bzip2() {
  fetch bzip2-1.0.8.tar.gz https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269
  rm -rf "$SRC/bzip2-1.0.8"; tar -C "$SRC" -xzf "$SRC/bzip2-1.0.8.tar.gz"
  ( cd "$SRC/bzip2-1.0.8"
    cc_objs blocksort huffman crctable randtable compress decompress bzlib
    "$AR" rcs "$SYSROOT/lib/libbz2.a" *.o
    cp bzlib.h "$SYSROOT/include/" )
  note "libbz2.a built"
}
build_xz() {
  fetch xz-5.4.6.tar.gz https://github.com/tukaani-project/xz/releases/download/v5.4.6/xz-5.4.6.tar.gz aeba3e03bf8140ddedf62a0a367158340520f6b384f75ca6045ccc6c0d43fd5c
  rm -rf "$SRC/xz-5.4.6"; tar -C "$SRC" -xzf "$SRC/xz-5.4.6.tar.gz"
  ( cd "$SRC/xz-5.4.6"
    # --disable-threads: liblzma's threaded encoder pulls pthread/static-init
    # code the NOMMU wasm guest traps on at startup. Nix only uses the
    # single-threaded xz path; the mt API symbols it still references
    # (lzma_stream_encoder_mt / lzma_cputhreads) are provided by libmiscstub.a.
    ./configure --host=wasm32-unknown-linux-musl --prefix="$SYSROOT" --disable-shared --enable-static \
      --disable-threads \
      --disable-xz --disable-xzdec --disable-lzmadec --disable-lzmainfo --disable-scripts --disable-doc \
      CC="$WRAP/wcc" AR="$WRAP/war" RANLIB="$WRAP/wranlib" >/dev/null
    make -j"$JOBS" >/dev/null
    make install >/dev/null )
  note "liblzma.a built (single-threaded)"
}
build_sodium() {
  fetch libsodium-1.0.19.tar.gz https://download.libsodium.org/libsodium/releases/libsodium-1.0.19.tar.gz 018d79fe0a045cca07331d37bd0cb57b2e838c51bc48fd837a1472e50068bbea
  rm -rf "$SRC/libsodium-stable"; tar -C "$SRC" -xzf "$SRC/libsodium-1.0.19.tar.gz"
  ( cd "$SRC/libsodium-stable"
    # autotools mis-detects C11/C23 secure-zero fns under cross — force absent.
    ./configure --host=wasm32-unknown-linux-musl --prefix="$SYSROOT" --disable-shared --enable-static \
      --disable-pie --disable-ssp --without-pthreads \
      ac_cv_func_memset_s=no ac_cv_func_explicit_bzero=no ac_cv_func_memset_explicit=no ac_cv_func_explicit_memset=no \
      CC="$WRAP/wcc" AR="$WRAP/war" RANLIB="$WRAP/wranlib" >/dev/null
    make -j"$JOBS" >/dev/null
    make install >/dev/null )
  note "libsodium.a built"
}
build_sqlite() {
  fetch sqlite-amalgamation-3450100.zip https://sqlite.org/2024/sqlite-amalgamation-3450100.zip 5592243caf28b2cdef41e6ab58d25d653dfc53deded8450eb66072c929f030c4
  rm -rf "$SRC/sqlite-amalgamation-3450100"; ( cd "$SRC" && unzip -oq sqlite-amalgamation-3450100.zip )
  ( cd "$SRC/sqlite-amalgamation-3450100"
    $CLANG $CFLAGS_GUEST -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_WAL -c sqlite3.c -o sqlite3.o
    "$AR" rcs "$SYSROOT/lib/libsqlite3.a" sqlite3.o
    cp sqlite3.h sqlite3ext.h "$SYSROOT/include/" )
  note "libsqlite3.a built"
}
build_brotli() {
  fetch brotli-1.1.0.tar.gz https://github.com/google/brotli/archive/refs/tags/v1.1.0.tar.gz e720a6ca29428b803f4ad165371771f5398faba397edf6778837a18599ea13ff
  rm -rf "$SRC/brotli-1.1.0"; tar -C "$SRC" -xzf "$SRC/brotli-1.1.0.tar.gz"
  ( cd "$SRC/brotli-1.1.0/c"
    for grp in common dec enc; do
      rm -f obj-*.o
      i=0; for f in "$grp"/*.c; do $CLANG $CFLAGS_GUEST -Iinclude -c "$f" -o "obj-$grp-$i.o"; i=$((i+1)); done
      "$AR" rcs "$SYSROOT/lib/libbrotli$grp.a" obj-$grp-*.o
    done
    cp -r include/brotli "$SYSROOT/include/" )
  note "libbrotli{common,dec,enc}.a built"
}
build_libarchive() {
  fetch libarchive-3.7.4.tar.gz https://github.com/libarchive/libarchive/releases/download/v3.7.4/libarchive-3.7.4.tar.gz 7875d49596286055b52439ed42f044bd8ad426aa4cc5aabd96bfe7abb971d5e8
  rm -rf "$SRC/libarchive-3.7.4"; tar -C "$SRC" -xzf "$SRC/libarchive-3.7.4.tar.gz"
  ( cd "$SRC/libarchive-3.7.4"
    # -shared lets configure mis-detect Windows/BSD fns musl lacks — force absent.
    ./configure --host=wasm32-unknown-linux-musl --prefix="$SYSROOT" --disable-shared --enable-static \
      --disable-bsdtar --disable-bsdcpio --disable-bsdcat --disable-bsdunzip \
      --without-xml2 --without-openssl --without-libb2 --without-lz4 --without-zstd \
      --without-nettle --without-expat --without-iconv --without-cng --without-lzo2 \
      ac_cv_func_arc4random_buf=no ac_cv_func__fseeki64=no ac_cv_func__ctime64_s=no \
      ac_cv_func__gmtime64_s=no ac_cv_func__localtime64_s=no ac_cv_func__mkgmtime=no ac_cv_func__get_timezone=no \
      CC="$WRAP/wcc" AR="$WRAP/war" RANLIB="$WRAP/wranlib" \
      CPPFLAGS="-I$SYSROOT/include" LDFLAGS="-L$SYSROOT/lib" >/dev/null
    make -j"$JOBS" libarchive.la >/dev/null
    cp .libs/libarchive.a "$SYSROOT/lib/"
    cp libarchive/archive.h libarchive/archive_entry.h "$SYSROOT/include/" )
  note "libarchive.a built"
}
build_openssl() {
  fetch openssl-3.3.2.tar.gz https://github.com/openssl/openssl/releases/download/openssl-3.3.2/openssl-3.3.2.tar.gz 2e8a40b01979afe8be0bbfb3de5dc1c6709fedb46d6c89c10da114ab5fc3d281
  rm -rf "$SRC/openssl-3.3.2"; tar -C "$SRC" -xzf "$SRC/openssl-3.3.2.tar.gz"
  ( cd "$SRC/openssl-3.3.2"
    # libcrypto only (Nix's hash.cc uses MD5/SHA1/SHA256/SHA512). no-asm (wasm),
    # static, no threads/dso/sock. -isystem $KHDR for crypto/mem_sec.c's
    # <linux/mman.h>; relax int-conversion (clang-18 errors on older openssl C).
    CC="$WRAP/wcc" AR="$WRAP/war" RANLIB="$WRAP/wranlib" \
      ./Configure linux-generic32 no-asm no-shared no-threads no-dso no-engine \
        no-tests no-apps no-docs no-quic no-module no-sock --prefix="$SYSROOT" \
        -isystem "$KHDR" -Wno-int-conversion -Wno-error=int-conversion -Wno-implicit-function-declaration >/dev/null
    make -j"$JOBS" build_generated >/dev/null   # opensslv.h etc. (generated from *.in)
    make -j"$JOBS" libcrypto.a >/dev/null
    make -j"$JOBS" libssl.a >/dev/null          # curl's TLS links -lssl too (Layer 2)
    cp libcrypto.a libssl.a "$SYSROOT/lib/"
    cp -rL include/openssl "$SYSROOT/include/" )
  note "libcrypto.a + libssl.a built"
}
build_editline() {
  fetch editline-1.17.1.tar.gz https://github.com/troglobit/editline/releases/download/1.17.1/editline-1.17.1.tar.gz 781e03b6a935df75d99fb963551e2e9f09a714a8c49fc53280c716c90bf44d26
  rm -rf "$SRC/editline-1.17.1"; tar -C "$SRC" -xzf "$SRC/editline-1.17.1.tar.gz"
  ( cd "$SRC/editline-1.17.1"
    ./configure --host=wasm32-unknown-linux-musl --prefix="$SYSROOT" --disable-shared --enable-static \
      CC="$WRAP/wcc" AR="$WRAP/war" RANLIB="$WRAP/wranlib" >/dev/null
    make -j"$JOBS" >/dev/null
    make install >/dev/null )
  note "libeditline.a built"
}
build_blake3() {
  fetch BLAKE3-1.5.4.tar.gz https://github.com/BLAKE3-team/BLAKE3/archive/refs/tags/1.5.4.tar.gz ddd24f26a31d23373e63d9be2e723263ac46c8b6d49902ab08024b573fd2a416
  rm -rf "$SRC/BLAKE3-1.5.4"; tar -C "$SRC" -xzf "$SRC/BLAKE3-1.5.4.tar.gz"
  ( cd "$SRC/BLAKE3-1.5.4/c"
    # Portable backend only — wasm has no SSE/AVX/NEON; the dispatcher falls
    # back to blake3_portable when every SIMD target is compiled out.
    PORT="-DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_NO_NEON"
    for f in blake3 blake3_dispatch blake3_portable; do $CLANG $CFLAGS_GUEST $PORT -c "$f.c" -o "$f.o"; done
    "$AR" rcs "$SYSROOT/lib/libblake3.a" blake3.o blake3_dispatch.o blake3_portable.o
    cp blake3.h "$SYSROOT/include/" )
  note "libblake3.a built"
}
build_toml11() {
  fetch toml11-3.8.1.tar.gz https://github.com/ToruNiina/toml11/archive/refs/tags/v3.8.1.tar.gz 6a3d20080ecca5ea42102c078d3415bef80920f6c4ea2258e87572876af77849
  rm -rf "$SRC/toml11-3.8.1"; tar -C "$SRC" -xzf "$SRC/toml11-3.8.1.tar.gz"
  cp -r "$SRC/toml11-3.8.1/toml.hpp" "$SRC/toml11-3.8.1/toml" "$SYSROOT/include/"   # header-only (C++)
  note "toml11 headers installed"
}
build_njson() {
  fetch json.hpp     https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp     9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6
  fetch json_fwd.hpp https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json_fwd.hpp 5cefbba751baf5243033fd894c70be9b37103d64b3d3a959e4173197d71137b9
  mkdir -p "$SYSROOT/include/nlohmann"
  cp "$SRC/json.hpp" "$SRC/json_fwd.hpp" "$SYSROOT/include/nlohmann/"
  note "nlohmann_json headers installed"
}

# --- Layer 2 (Nix-specific): curl (binary-cache HTTP), boost_url (URL parsing),
#     git2 (fail-at-runtime stubs — a local nix-build never fetches git). ---------

# curl 8.11.1 over the sysroot's openssl + zlib; the long --disable/--without set
# strips every protocol/feature Nix doesn't use (so no extra deps). The cross
# recv/send/select checks can't run → assert them; gsasl is auto-detected from a
# host header → `ac_cv_header_gsasl_h=no` + a post-configure sed keep it out.
build_curl() {
  fetch curl-8.11.1.tar.gz https://curl.se/download/curl-8.11.1.tar.gz a889ac9dbba3644271bd9d1302b5c22a088893719b72be3487bc3d401e5c4e80
  rm -rf "$SRC/curl-8.11.1"; tar -C "$SRC" -xzf "$SRC/curl-8.11.1.tar.gz"
  ( cd "$SRC/curl-8.11.1"
    ./configure --host=wasm32-unknown-linux-musl --prefix="$SYSROOT" --disable-shared --enable-static \
      --with-openssl="$SYSROOT" --with-zlib="$SYSROOT" \
      --without-libpsl --without-libidn2 --without-brotli --without-zstd --without-nghttp2 --without-librtmp \
      --disable-ldap --disable-ldaps --disable-rtsp --disable-dict --disable-telnet --disable-tftp \
      --disable-pop3 --disable-imap --disable-smtp --disable-gopher --disable-mqtt --disable-smb --disable-manual \
      --disable-threaded-resolver --disable-ntlm --disable-unix-sockets --without-gsasl --without-libssh2 \
      --without-libssh --without-gssapi --disable-kerberos-auth --disable-negotiate-auth \
      ac_cv_func_recv=yes ac_cv_func_send=yes ac_cv_func_select=yes ac_cv_header_gsasl_h=no \
      CC="$WRAP/wcc" AR="$WRAP/war" RANLIB="$WRAP/wranlib" \
      PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig" CPPFLAGS="-I$SYSROOT/include" LDFLAGS="-L$SYSROOT/lib" >/dev/null
    sed -i '/define USE_GSASL/d' lib/curl_config.h
    make -j"$JOBS" -C lib >/dev/null
    cp lib/.libs/libcurl.a "$SYSROOT/lib/"
    cp -r include/curl "$SYSROOT/include/" )
  note "libcurl.a built"
}

# Boost.URL — built from the full Boost 1.90.0 RELEASE so the URL sources AND
# their header deps (core/assert/config/system/mp11/variant2/…) all come from
# ONE pinned tree. The earlier recipe cloned only boostorg/url and pulled the
# dep headers from the host apt libboost-dev via `-idirafter /usr/include` — a
# silent host-version leak that built on a machine with Boost ≥1.90 but FAILED
# in CI (Ubuntu's older Boost lacks headers the 1.90 url module needs, e.g.
# boost/core/detail/static_assert.hpp). The full boost/ header tree is also
# installed into the sysroot so Nix's own boost::url compile resolves it there
# (it has the same dependency closure), not from a host include path.
build_boost_url() {
  fetch boost_1_90_0.tar.bz2 https://archives.boost.io/release/1.90.0/source/boost_1_90_0.tar.bz2 49551aff3b22cbc5c5a9ed3dbc92f0e23ea50a0f7325b0d198b705e8ee3fc305
  rm -rf "$SRC/boost_1_90_0"; tar -C "$SRC" -xf "$SRC/boost_1_90_0.tar.bz2"
  ( cd "$SRC/boost_1_90_0"; rm -rf obj; mkdir obj
    for f in libs/url/src/*.cpp; do
      $CXX -I . -c "$f" -o "obj/$(basename "${f%.cpp}").o"
    done
    "$AR" rcs "$SYSROOT/lib/libboost_url.a" obj/*.o )
  cp -r "$SRC/boost_1_90_0/boost" "$SYSROOT/include/"   # full headers (url + deps)
  note "libboost_url.a built (Boost 1.90.0 release, self-contained)"
}

# git2: Nix references libgit2 for builtins.fetchGit, which a local nix-build
# never invokes — link fail-at-runtime stubs (nixbuild/git2-stubs.c, generated
# from the apt libgit2 headers) instead of cross-building git2 itself.
build_git2_stubs() {
  $CLANG $CFLAGS_GUEST -idirafter /usr/include -c "$HERE/../nixbuild/git2-stubs.c" -o "$SRC/git2-stubs.o"
  "$AR" rcs "$SYSROOT/lib/libgit2.a" "$SRC/git2-stubs.o"
  cp -r /usr/include/git2.h /usr/include/git2 "$SYSROOT/include/" 2>/dev/null || true
  note "libgit2.a (stubs) built"
}

DEPS=("${@:-zlib bzip2 xz sodium sqlite brotli libarchive openssl editline blake3 toml11 njson curl boost_url git2}")
for d in ${DEPS[@]}; do
  case "$d" in
    zlib) build_zlib;; bzip2) build_bzip2;; xz) build_xz;; sodium) build_sodium;;
    sqlite) build_sqlite;; brotli) build_brotli;; libarchive) build_libarchive;;
    openssl) build_openssl;; editline) build_editline;; blake3) build_blake3;; toml11) build_toml11;; njson) build_njson;;
    curl) build_curl;; boost_url) build_boost_url;; git2) build_git2_stubs;;
    *) die "unknown dep: $d";;
  esac
done

note "sysroot ready at $SYSROOT"
ls -la "$SYSROOT/lib"/*.a 2>/dev/null | awk '{printf "  %8d  %s\n",$5,$9}'
