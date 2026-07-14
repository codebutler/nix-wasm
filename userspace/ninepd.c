/* ninepd.c — guest-side READ-ONLY 9P2000.L file server for pc's /Linux mount
 * (pc issue #472): the mirror image of the host→guest /mnt/pc mount. pc's VFS
 * grows a 9P *client* (pc js/vfs/backends/guest-9p.js); this daemon serves the
 * guest's rootfs to it, so the host browses the RUNNING system live (Filer,
 * the tray-menu app launcher reading /run/current-system/sw/share/applications).
 *
 * Transport is the /Ctl reverse-connection trick (see pcctl.c): the host
 * cannot initiate a vsock connection into the guest, so we connect OUT to the
 * host (VMADDR_CID_HOST = 2) on the well-known port and hold the stream. pc
 * listens (pc js/linux/guest-fs.js), handshakes, and mounts /Linux for exactly
 * the connection's lifetime. On EOF/error we loop and reconnect — pc replaces
 * the mount on a fresh dial-in. Started from inittab (::respawn as a safety
 * net around the internal retry loop).
 *
 * Design constraints, in order:
 *   - NOMMU-clean: no fork, no threads — one blocking connection served
 *     sequentially (requests are handled in arrival order; the host client
 *     pipelines tags but does not require out-of-order replies).
 *   - READ-ONLY: every mutating op (write/create/remove/rename/setattr...)
 *     answers Rlerror(EROFS). Tlopen rejects any write/creat/trunc flags.
 *   - Symlinks are NOT followed server-side (standard 9P): walks stop at a
 *     symlink component (partial Rwalk) and Treadlink serves the target — the
 *     client does the splice, exactly like the kernel's own v9fs.
 *   - THE RECURSION GUARD: /mnt/pc is the host's OWN filesystem mounted into
 *     this guest. Serving it back to the host would make the two mounts
 *     recurse into each other (/mnt/pc/Linux/mnt/pc/...). EXCLUDE_PATH is
 *     invisible: hidden from readdir, ENOENT on walk.
 *
 * Test seams (native builds; the wasm build ignores them unless set):
 *   NINEPD_TCP_PORT — connect to 127.0.0.1:<port> over TCP instead of vsock
 *                     (the runtime/ninep interop test drives the real binary).
 *   NINEPD_ROOT     — serve this directory as "/" (default "/").
 *   NINEPD_PORT     — override the vsock port (default 1025).
 *   NINEPD_ONESHOT  — serve one connection then exit (tests). */
#define _GNU_SOURCE /* DT_* dirent types, strdup, pread under musl + glibc */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __wasm__
#include <linux/vm_sockets.h>
#else
/* Native test builds: vsock headers may be absent; TCP mode is used instead. */
#ifdef __has_include
#if __has_include(<linux/vm_sockets.h>)
#include <linux/vm_sockets.h>
#define HAVE_VSOCK 1
#endif
#endif
#endif
#ifdef __wasm__
#define HAVE_VSOCK 1
#endif

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif

/* Well-known host vsock port — MUST match pc js/linux/guest-fs.js
 * (GUEST_FS_PORT). /Ctl is 1024; this is the next system port up. */
#define P9_PORT 1025

/* The host's own filesystem, mounted into this guest — never serve it back. */
#define EXCLUDE_PATH "/mnt/pc"

#define MAX_MSIZE 65536u
#define MAX_FIDS 128
#define MAX_WELEM 16
#define PATHMAX 3072

/* ── 9P2000.L message types ─────────────────────────────────────────────── */
enum {
  Rlerror = 7,
  Tstatfs = 8,
  Rstatfs = 9,
  Tlopen = 12,
  Rlopen = 13,
  Treadlink = 22,
  Rreadlink = 23,
  Tgetattr = 24,
  Rgetattr = 25,
  Txattrwalk = 30,
  Treaddir = 40,
  Rreaddir = 41,
  Tversion = 100,
  Rversion = 101,
  Tattach = 104,
  Rattach = 105,
  Tflush = 108,
  Rflush = 109,
  Twalk = 110,
  Rwalk = 111,
  Tread = 116,
  Rread = 117,
  Tclunk = 120,
  Rclunk = 121,
};
/* Mutating T-messages we answer EROFS (anything else unknown → ENOSYS). */
static int is_mutating(int type) {
  switch (type) {
    case 14: /* Tlcreate */
    case 16: /* Tsymlink */
    case 18: /* Tmknod */
    case 20: /* Trename */
    case 26: /* Tsetattr */
    case 50: /* Tfsync */
    case 72: /* Tmkdir */
    case 74: /* Trenameat */
    case 76: /* Tunlinkat */
    case 118: /* Twrite */
    case 122: /* Tremove */
      return 1;
  }
  return 0;
}

#define QT_DIR 0x80
#define QT_SYMLINK 0x02
#define QT_FILE 0x00
#define GETATTR_BASIC 0x000007ffULL
#define V9FS_MAGIC 0x01021997

/* open(2) accmode + refused flags on Tlopen (Linux values — the wire ABI). */
#define L_O_ACCMODE 0x3
#define L_O_CREAT 0x40
#define L_O_TRUNC 0x200
#define L_O_APPEND 0x400

/* ── little-endian wire helpers ─────────────────────────────────────────── */
static uint8_t inbuf[MAX_MSIZE], outbuf[MAX_MSIZE];
static size_t outpos;
static uint32_t msize = MAX_MSIZE;

static void w_reset(void) { outpos = 0; }
static void w_u8(uint8_t v) { outbuf[outpos++] = v; }
static void w_u16(uint16_t v) {
  outbuf[outpos++] = v & 0xff;
  outbuf[outpos++] = v >> 8;
}
static void w_u32(uint32_t v) {
  for (int i = 0; i < 4; i++) outbuf[outpos++] = (v >> (8 * i)) & 0xff;
}
static void w_u64(uint64_t v) {
  for (int i = 0; i < 8; i++) outbuf[outpos++] = (v >> (8 * i)) & 0xff;
}
static void w_str(const char *s, size_t n) {
  w_u16((uint16_t)n);
  memcpy(outbuf + outpos, s, n);
  outpos += n;
}

static uint16_t r_u16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t r_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t r_u64(const uint8_t *p) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}

/* ── fid table ──────────────────────────────────────────────────────────── */
struct dent {
  uint64_t ino;
  uint8_t dtype;
  char *name;
};
struct fid {
  int in_use;
  uint32_t fid;
  char path[PATHMAX]; /* logical path, "/"-rooted */
  int fd;             /* open file, or -1 */
  struct dent *ents;  /* readdir cache, or NULL */
  size_t nents;
};
static struct fid fids[MAX_FIDS];
static const char *serve_root = "/";

static void free_ents(struct fid *f) {
  if (!f->ents) return;
  for (size_t i = 0; i < f->nents; i++) free(f->ents[i].name);
  free(f->ents);
  f->ents = NULL;
  f->nents = 0;
}
static void fid_drop(struct fid *f) {
  if (f->fd >= 0) close(f->fd);
  free_ents(f);
  memset(f, 0, sizeof(*f));
  f->fd = -1;
}
static struct fid *fid_get(uint32_t fid) {
  for (int i = 0; i < MAX_FIDS; i++)
    if (fids[i].in_use && fids[i].fid == fid) return &fids[i];
  return NULL;
}
static struct fid *fid_new(uint32_t fid) {
  struct fid *old = fid_get(fid);
  if (old) fid_drop(old); /* client reuse of a fid number clunks the old one */
  for (int i = 0; i < MAX_FIDS; i++) {
    if (!fids[i].in_use) {
      memset(&fids[i], 0, sizeof(fids[i]));
      fids[i].in_use = 1;
      fids[i].fid = fid;
      fids[i].fd = -1;
      return &fids[i];
    }
  }
  return NULL;
}

/* logical path → real path under serve_root (bounded). */
static int real_path(const char *logical, char *out, size_t outsz) {
  size_t rl = strlen(serve_root);
  /* serve_root "/" → logical as-is; otherwise root + logical ("/" → root). */
  if (rl == 1 && serve_root[0] == '/') {
    if (strlen(logical) >= outsz) return -1;
    strcpy(out, logical);
    return 0;
  }
  if (strcmp(logical, "/") == 0) {
    if (rl >= outsz) return -1;
    strcpy(out, serve_root);
    return 0;
  }
  if (rl + strlen(logical) >= outsz) return -1;
  strcpy(out, serve_root);
  strcat(out, logical);
  return 0;
}

static int is_excluded(const char *logical) {
  return strcmp(logical, EXCLUDE_PATH) == 0;
}

/* qid from an lstat — type from mode, path from inode, version from mtime. */
static void qid_of(const struct stat *st, uint8_t *type, uint32_t *version, uint64_t *path) {
  *type = S_ISDIR(st->st_mode) ? QT_DIR : S_ISLNK(st->st_mode) ? QT_SYMLINK : QT_FILE;
  *version = (uint32_t)st->st_mtime;
  *path = (uint64_t)st->st_ino;
}

/* ── frame plumbing ─────────────────────────────────────────────────────── */
static int write_all(int fd, const void *buf, size_t n) {
  const char *p = buf;
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (w == 0) return -1;
    p += w;
    n -= (size_t)w;
  }
  return 0;
}
static int read_all(int fd, void *buf, size_t n) {
  char *p = buf;
  while (n) {
    ssize_t r = read(fd, p, n);
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (r == 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

/* Begin a reply frame (size backpatched at send). */
static void reply_begin(uint8_t type, uint16_t tag) {
  w_reset();
  w_u32(0);
  w_u8(type);
  w_u16(tag);
}
static int reply_send(int sock) {
  uint32_t sz = (uint32_t)outpos;
  outbuf[0] = sz & 0xff;
  outbuf[1] = (sz >> 8) & 0xff;
  outbuf[2] = (sz >> 16) & 0xff;
  outbuf[3] = (sz >> 24) & 0xff;
  return write_all(sock, outbuf, outpos);
}
static int rlerror(int sock, uint16_t tag, uint32_t ecode) {
  reply_begin(Rlerror, tag);
  w_u32(ecode);
  return reply_send(sock);
}

/* ── per-message handlers (each sends its own reply) ────────────────────── */

static int do_version(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 6) return rlerror(sock, tag, EINVAL);
  uint32_t want = r_u32(b);
  uint16_t vlen = r_u16(b + 4);
  if (n < 6u + vlen) return rlerror(sock, tag, EINVAL);
  msize = want < MAX_MSIZE ? want : MAX_MSIZE;
  if (msize < 4096) msize = 4096;
  int ok = vlen == 8 && memcmp(b + 6, "9P2000.L", 8) == 0;
  reply_begin(Rversion, tag);
  w_u32(msize);
  if (ok) w_str("9P2000.L", 8);
  else w_str("unknown", 7);
  return reply_send(sock);
}

static int do_attach(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 8) return rlerror(sock, tag, EINVAL);
  uint32_t fid = r_u32(b);
  struct fid *f = fid_new(fid);
  if (!f) return rlerror(sock, tag, ENOMEM);
  strcpy(f->path, "/");
  char rp[PATHMAX + 64];
  struct stat st;
  if (real_path(f->path, rp, sizeof(rp)) != 0 || lstat(rp, &st) != 0) {
    fid_drop(f);
    return rlerror(sock, tag, errno ? errno : EIO);
  }
  uint8_t qt;
  uint32_t qv;
  uint64_t qp;
  qid_of(&st, &qt, &qv, &qp);
  reply_begin(Rattach, tag);
  w_u8(qt);
  w_u32(qv);
  w_u64(qp);
  return reply_send(sock);
}

/* Append one component to a logical path, resolving "." and ".." lexically
 * (".." clamps at "/", like the JS server). Returns -1 on overflow/bad name. */
static int path_join(char *path, const char *name, size_t namelen) {
  if (namelen == 0 || memchr(name, '/', namelen)) return -1;
  if (namelen == 1 && name[0] == '.') return 0;
  if (namelen == 2 && name[0] == '.' && name[1] == '.') {
    char *slash = strrchr(path, '/');
    if (slash && slash != path) *slash = '\0';
    else strcpy(path, "/");
    return 0;
  }
  size_t plen = strlen(path);
  if (plen + 1 + namelen + 1 >= PATHMAX) return -1;
  if (!(plen == 1 && path[0] == '/')) path[plen++] = '/';
  else plen = 1;
  memcpy(path + plen, name, namelen);
  path[plen + namelen] = '\0';
  return 0;
}

static int do_walk(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 10) return rlerror(sock, tag, EINVAL);
  uint32_t fid = r_u32(b), newfid = r_u32(b + 4);
  uint16_t nwname = r_u16(b + 8);
  if (nwname > MAX_WELEM) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(fid);
  if (!f) return rlerror(sock, tag, EBADF);

  char path[PATHMAX];
  strcpy(path, f->path);
  /* Collect qids as we go; stop early on ENOENT / symlink-with-more / exclude. */
  uint8_t qts[MAX_WELEM];
  uint32_t qvs[MAX_WELEM];
  uint64_t qps[MAX_WELEM];
  uint16_t nq = 0;
  const uint8_t *p = b + 10;
  size_t rem = n - 10;
  int stopped = 0;
  for (uint16_t i = 0; i < nwname && !stopped; i++) {
    if (rem < 2) return rlerror(sock, tag, EINVAL);
    uint16_t nl = r_u16(p);
    p += 2;
    rem -= 2;
    if (rem < nl) return rlerror(sock, tag, EINVAL);
    const char *name = (const char *)p;
    p += nl;
    rem -= nl;
    if (path_join(path, name, nl) != 0) {
      if (nq == 0) return rlerror(sock, tag, ENOENT);
      break;
    }
    struct stat st;
    char rp[PATHMAX + 64];
    if (is_excluded(path) || real_path(path, rp, sizeof(rp)) != 0 || lstat(rp, &st) != 0) {
      if (nq == 0) return rlerror(sock, tag, ENOENT);
      break; /* partial walk */
    }
    qid_of(&st, &qts[nq], &qvs[nq], &qps[nq]);
    nq++;
    /* A symlink with components still to walk: standard 9P stops here (the
     * client readlinks + splices). Include the symlink's own qid, then stop. */
    if (S_ISLNK(st.st_mode) && i + 1 < nwname) stopped = 1;
  }

  if (nq == nwname) {
    struct fid *nf = fid_new(newfid);
    if (!nf) return rlerror(sock, tag, ENOMEM);
    strcpy(nf->path, path);
  }
  reply_begin(Rwalk, tag);
  w_u16(nq);
  for (uint16_t i = 0; i < nq; i++) {
    w_u8(qts[i]);
    w_u32(qvs[i]);
    w_u64(qps[i]);
  }
  return reply_send(sock);
}

static int do_getattr(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 12) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(r_u32(b));
  if (!f) return rlerror(sock, tag, EBADF);
  char rp[PATHMAX + 64];
  struct stat st;
  if (real_path(f->path, rp, sizeof(rp)) != 0 || lstat(rp, &st) != 0)
    return rlerror(sock, tag, errno ? errno : EIO);
  uint8_t qt;
  uint32_t qv;
  uint64_t qp;
  qid_of(&st, &qt, &qv, &qp);
  reply_begin(Rgetattr, tag);
  w_u64(GETATTR_BASIC);
  w_u8(qt);
  w_u32(qv);
  w_u64(qp);
  w_u32(st.st_mode);
  w_u32(st.st_uid);
  w_u32(st.st_gid);
  w_u64(st.st_nlink);
  w_u64((uint64_t)st.st_rdev);
  w_u64((uint64_t)st.st_size);
  w_u64(st.st_blksize ? (uint64_t)st.st_blksize : 4096);
  w_u64((uint64_t)st.st_blocks);
  w_u64((uint64_t)st.st_atime);
  w_u64(0);
  w_u64((uint64_t)st.st_mtime);
  w_u64(0);
  w_u64((uint64_t)st.st_ctime);
  w_u64(0);
  w_u64(0); /* btime */
  w_u64(0);
  w_u64(0); /* gen */
  w_u64(0); /* data_version */
  return reply_send(sock);
}

static int do_readlink(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 4) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(r_u32(b));
  if (!f) return rlerror(sock, tag, EBADF);
  char rp[PATHMAX + 64], target[PATHMAX];
  if (real_path(f->path, rp, sizeof(rp)) != 0) return rlerror(sock, tag, ENAMETOOLONG);
  ssize_t tl = readlink(rp, target, sizeof(target) - 1);
  if (tl < 0) return rlerror(sock, tag, errno);
  reply_begin(Rreadlink, tag);
  w_str(target, (size_t)tl);
  return reply_send(sock);
}

static int do_lopen(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 8) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(r_u32(b));
  if (!f) return rlerror(sock, tag, EBADF);
  uint32_t flags = r_u32(b + 4);
  if ((flags & L_O_ACCMODE) != 0 || (flags & (L_O_CREAT | L_O_TRUNC | L_O_APPEND)))
    return rlerror(sock, tag, EROFS);
  char rp[PATHMAX + 64];
  struct stat st;
  if (real_path(f->path, rp, sizeof(rp)) != 0 || lstat(rp, &st) != 0)
    return rlerror(sock, tag, errno ? errno : EIO);
  if (S_ISREG(st.st_mode)) {
    int fd = open(rp, O_RDONLY);
    if (fd < 0) return rlerror(sock, tag, errno);
    if (f->fd >= 0) close(f->fd);
    f->fd = fd;
  } /* dirs: nothing to open — Treaddir scans on demand. */
  uint8_t qt;
  uint32_t qv;
  uint64_t qp;
  qid_of(&st, &qt, &qv, &qp);
  reply_begin(Rlopen, tag);
  w_u8(qt);
  w_u32(qv);
  w_u64(qp);
  w_u32(0); /* iounit: 0 = use msize */
  return reply_send(sock);
}

static int do_read(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 16) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(r_u32(b));
  if (!f) return rlerror(sock, tag, EBADF);
  if (f->fd < 0) return rlerror(sock, tag, EBADF);
  uint64_t off = r_u64(b + 4);
  uint32_t count = r_u32(b + 12);
  uint32_t max = msize - 24;
  if (count > max) count = max;
  reply_begin(Rread, tag);
  w_u32(0); /* count placeholder */
  ssize_t got = pread(f->fd, outbuf + outpos, count, (off_t)off);
  if (got < 0) return rlerror(sock, tag, errno);
  size_t cpos = outpos - 4;
  outbuf[cpos] = got & 0xff;
  outbuf[cpos + 1] = ((size_t)got >> 8) & 0xff;
  outbuf[cpos + 2] = ((size_t)got >> 16) & 0xff;
  outbuf[cpos + 3] = ((size_t)got >> 24) & 0xff;
  outpos += (size_t)got;
  return reply_send(sock);
}

static int dent_cmp(const void *a, const void *b) {
  return strcmp(((const struct dent *)a)->name, ((const struct dent *)b)->name);
}

/* Scan a directory into the fid's dent cache (sorted for stable offsets). */
static int scan_dir(struct fid *f) {
  free_ents(f);
  char rp[PATHMAX + 64];
  if (real_path(f->path, rp, sizeof(rp)) != 0) return -1;
  DIR *d = opendir(rp);
  if (!d) return -1;
  size_t cap = 64, cnt = 0;
  struct dent *ents = malloc(cap * sizeof(*ents));
  if (!ents) {
    closedir(d);
    return -1;
  }
  int at_exclude_parent = 0;
  {
    /* Is this dir the PARENT of the excluded path? Compare logical paths. */
    const char *slash = strrchr(EXCLUDE_PATH, '/');
    size_t plen = (size_t)(slash - EXCLUDE_PATH);
    if (plen == 0) plen = 1; /* parent is "/" */
    at_exclude_parent = strlen(f->path) == plen && strncmp(f->path, EXCLUDE_PATH, plen) == 0;
    if (plen == 1) at_exclude_parent = strcmp(f->path, "/") == 0;
  }
  struct dirent *e;
  while ((e = readdir(d))) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    if (at_exclude_parent && strcmp(e->d_name, strrchr(EXCLUDE_PATH, '/') + 1) == 0)
      continue; /* the recursion guard: hide /mnt/pc from its parent's listing */
    if (cnt == cap) {
      cap *= 2;
      struct dent *ne = realloc(ents, cap * sizeof(*ents));
      if (!ne) break;
      ents = ne;
    }
    ents[cnt].ino = (uint64_t)e->d_ino;
    ents[cnt].dtype = e->d_type;
    ents[cnt].name = strdup(e->d_name);
    if (!ents[cnt].name) break;
    cnt++;
  }
  closedir(d);
  qsort(ents, cnt, sizeof(*ents), dent_cmp);
  f->ents = ents;
  f->nents = cnt;
  return 0;
}

static int do_readdir(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 16) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(r_u32(b));
  if (!f) return rlerror(sock, tag, EBADF);
  uint64_t off = r_u64(b + 4);
  uint32_t count = r_u32(b + 12);
  uint32_t max = msize - 24;
  if (count > max) count = max;
  if (off == 0 || !f->ents) {
    if (scan_dir(f) != 0) return rlerror(sock, tag, errno ? errno : EIO);
  }
  reply_begin(Rreaddir, tag);
  w_u32(0); /* data-count placeholder */
  size_t cpos = outpos - 4;
  size_t total = 0;
  /* offsets are 1-based entry indexes: entry i carries offset i+1; a request
   * at offset k resumes with entry k. */
  for (size_t i = (size_t)off; i < f->nents; i++) {
    struct dent *e = &f->ents[i];
    size_t nl = strlen(e->name);
    size_t need = 13 + 8 + 1 + 2 + nl;
    if (total + need > count) break;
    uint8_t qt = e->dtype == DT_DIR ? QT_DIR : e->dtype == DT_LNK ? QT_SYMLINK : QT_FILE;
    w_u8(qt);
    w_u32(0);
    w_u64(e->ino);
    w_u64((uint64_t)i + 1);
    w_u8(e->dtype);
    w_str(e->name, nl);
    total += need;
  }
  outbuf[cpos] = total & 0xff;
  outbuf[cpos + 1] = (total >> 8) & 0xff;
  outbuf[cpos + 2] = (total >> 16) & 0xff;
  outbuf[cpos + 3] = (total >> 24) & 0xff;
  return reply_send(sock);
}

static int do_statfs(int sock, uint16_t tag) {
  reply_begin(Rstatfs, tag);
  w_u32(V9FS_MAGIC);
  w_u32(4096);
  w_u64(1 << 20);
  w_u64(0);
  w_u64(0); /* read-only: no free/avail */
  w_u64(1 << 16);
  w_u64(0);
  w_u64(0);
  w_u32(255);
  return reply_send(sock);
}

static int do_clunk(int sock, uint16_t tag, const uint8_t *b, size_t n) {
  if (n < 4) return rlerror(sock, tag, EINVAL);
  struct fid *f = fid_get(r_u32(b));
  if (f) fid_drop(f);
  reply_begin(Rclunk, tag);
  return reply_send(sock);
}

/* ── connection loop ────────────────────────────────────────────────────── */
static void reset_fids(void) {
  for (int i = 0; i < MAX_FIDS; i++)
    if (fids[i].in_use) fid_drop(&fids[i]);
}

static int serve(int sock) {
  reset_fids();
  msize = MAX_MSIZE;
  for (;;) {
    uint8_t szb[4];
    if (read_all(sock, szb, 4) != 0) return 0; /* EOF/hangup — reconnect */
    uint32_t sz = r_u32(szb);
    if (sz < 7 || sz > MAX_MSIZE) return 0; /* desync — drop the connection */
    if (read_all(sock, inbuf, sz - 4) != 0) return 0;
    uint8_t type = inbuf[0];
    uint16_t tag = r_u16(inbuf + 1);
    const uint8_t *body = inbuf + 3;
    size_t blen = sz - 7;
    int rc;
    switch (type) {
      case Tversion: rc = do_version(sock, tag, body, blen); break;
      case Tattach: rc = do_attach(sock, tag, body, blen); break;
      case Twalk: rc = do_walk(sock, tag, body, blen); break;
      case Tgetattr: rc = do_getattr(sock, tag, body, blen); break;
      case Treadlink: rc = do_readlink(sock, tag, body, blen); break;
      case Tlopen: rc = do_lopen(sock, tag, body, blen); break;
      case Tread: rc = do_read(sock, tag, body, blen); break;
      case Treaddir: rc = do_readdir(sock, tag, body, blen); break;
      case Tstatfs: rc = do_statfs(sock, tag); break;
      case Tclunk: rc = do_clunk(sock, tag, body, blen); break;
      case Tflush: /* sequential server: the referenced request already completed */
        reply_begin(Rflush, tag);
        rc = reply_send(sock);
        break;
      case Txattrwalk: rc = rlerror(sock, tag, ENODATA); break;
      default: rc = rlerror(sock, tag, is_mutating(type) ? EROFS : ENOSYS); break;
    }
    if (rc != 0) return 0; /* write failed — connection is gone */
  }
}

static int connect_out(void) {
  const char *tcp = getenv("NINEPD_TCP_PORT");
  if (tcp && *tcp) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)atoi(tcp));
    a.sin_addr.s_addr = htonl(0x7f000001);
    if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) {
      close(fd);
      return -1;
    }
    return fd;
  }
#ifdef HAVE_VSOCK
  unsigned int port = P9_PORT;
  const char *pe = getenv("NINEPD_PORT");
  if (pe && *pe) {
    long p = strtol(pe, NULL, 10);
    if (p > 0 && p < 65536) port = (unsigned int)p;
  }
  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_vm addr;
  memset(&addr, 0, sizeof(addr));
  addr.svm_family = AF_VSOCK;
  addr.svm_cid = VMADDR_CID_HOST;
  addr.svm_port = port;
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
#else
  errno = EAFNOSUPPORT;
  return -1;
#endif
}

int main(void) {
  const char *root = getenv("NINEPD_ROOT");
  if (root && *root) serve_root = root;
  int oneshot = getenv("NINEPD_ONESHOT") != NULL;
  for (int i = 0; i < MAX_FIDS; i++) fids[i].fd = -1;
  for (;;) {
    int sock = connect_out();
    if (sock < 0) {
      if (oneshot) return 1;
      sleep(2); /* pc not listening yet (or gone) — keep dialing */
      continue;
    }
    serve(sock);
    close(sock);
    if (oneshot) return 0;
    sleep(1); /* brief backoff, then offer the mount again */
  }
}
