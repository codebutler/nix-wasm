/* pthread-exit-test — musl memory-compat regression test on wasm Linux.
 *
 * First prove why the local posix_fallocate emulation remains necessary on
 * both supported kernels: /tmp remains ramfs, whose native fallocate(2) returns
 * EOPNOTSUPP, while posix_fallocate() must still grow a regular file without
 * changing its offset or contents. /dev/shm is ramfs on NOMMU and normal tmpfs
 * on MMU; the test requires native fallocate to match that actual filesystem.
 *
 * A DETACHED pthread that returns/exits goes through musl __pthread_exit →
 * __unmapself, which on the generic path does a native stack-pointer switch
 * (CRTJMP) to munmap its own stack — impossible on wasm, where CRTJMP is a stub
 * that abort()s → SIGILL (exit 132). GLib GThreadPool workers (gdk-pixbuf/GTask,
 * used by GTK apps like gtk3-widget-factory) are detached threads, so this crash
 * blocked GTK rendering. patches/musl/0008 replaces __unmapself on wasm with an
 * inline munmap+exit (no stack switch). The second half spawns several detached
 * threads that immediately exit; if the fix is missing the process dies with
 * SIGILL and never prints the OK line. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

#define RAMFS_MAGIC 0x858458f6
#define TMPFS_MAGIC 0x01021994

static int test_fallocate(const char *path) {
  const off_t base = 4096;
  const off_t len = 8192;
  const off_t expected_size = base + len;
  const off_t expected_offset = 7;
  const off_t marker_offset = base + 123;
  const unsigned char marker = 0x5a;
  unsigned char actual = 0;
  struct stat st;
  struct statfs fs;

  int fd = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
  if (fd < 0) {
    printf("FALLOCATE-TEST: %s open failed: %s FAIL\n", path, strerror(errno));
    return 1;
  }

  int failed = 0;
  /* Pre-size part-way into the requested allocation range. posix_fallocate()
   * must preserve existing bytes in that range, not merely bytes before it. */
  if (pwrite(fd, &marker, 1, marker_offset) != 1 ||
      lseek(fd, expected_offset, SEEK_SET) != expected_offset) {
    printf("FALLOCATE-TEST: %s setup failed: %s FAIL\n", path, strerror(errno));
    failed = 1;
    goto out;
  }

  if (fstatfs(fd, &fs) != 0) {
    printf("FALLOCATE-TEST: %s fstatfs failed: %s FAIL\n", path,
           strerror(errno));
    failed = 1;
    goto out;
  }
  if (fs.f_type != RAMFS_MAGIC && fs.f_type != TMPFS_MAGIC) {
    printf("FALLOCATE-TEST: %s unexpected filesystem type=%lx FAIL\n", path,
           (unsigned long)fs.f_type);
    failed = 1;
    goto out;
  }

  errno = 0;
  int raw_rc = fallocate(fd, 0, base, len);
  int raw_errno = errno;
  if ((fs.f_type == TMPFS_MAGIC && raw_rc != 0) ||
      (fs.f_type == RAMFS_MAGIC &&
       (raw_rc == 0 || (raw_errno != EOPNOTSUPP && raw_errno != ENOSYS)))) {
    printf("FALLOCATE-TEST: %s raw fallocate rc=%d errno=%d mismatches fs=%s FAIL\n",
           path, raw_rc, raw_errno,
           fs.f_type == TMPFS_MAGIC ? "tmpfs" : "ramfs");
    failed = 1;
    goto out;
  }

  int rc = posix_fallocate(fd, base, len);
  if (rc != 0) {
    printf("FALLOCATE-TEST: %s posix_fallocate rc=%d (%s) FAIL\n", path, rc,
           strerror(rc));
    failed = 1;
    goto out;
  }
  if (fstat(fd, &st) != 0) {
    printf("FALLOCATE-TEST: %s fstat failed: %s FAIL\n", path, strerror(errno));
    failed = 1;
    goto out;
  }
  if (st.st_size < expected_size) {
    printf("FALLOCATE-TEST: %s size=%lld expected>=%lld FAIL\n", path,
           (long long)st.st_size, (long long)expected_size);
    failed = 1;
    goto out;
  }
  if (lseek(fd, 0, SEEK_CUR) != expected_offset ||
      pread(fd, &actual, 1, marker_offset) != 1 || actual != marker) {
    printf("FALLOCATE-TEST: %s offset/content preservation FAIL\n", path);
    failed = 1;
    goto out;
  }

  const char *fs_name = fs.f_type == TMPFS_MAGIC ? "tmpfs" : "ramfs";
  const char *raw_name = raw_rc == 0
                             ? "OK"
                             : (raw_errno == EOPNOTSUPP ? "EOPNOTSUPP" : "ENOSYS");
  printf("FALLOCATE-TEST: %s fs=%s raw=%s posix=OK size=%lld offset/content=OK\n",
         path, fs_name, raw_name, (long long)st.st_size);

out:
  close(fd);
  unlink(path);
  return failed;
}

static void *worker(void *arg) {
  (void)arg;
  return NULL; /* detached thread returns → __pthread_exit → __unmapself */
}

int main(void) {
  if (test_fallocate("/tmp/posix-fallocate-test") != 0 ||
      test_fallocate("/dev/shm/posix-fallocate-test") != 0)
    return 1;

  const int N = 16;
  for (int i = 0; i < N; i++) {
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_t t;
    int rc = pthread_create(&t, &attr, worker, NULL);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
      printf("PTHREAD-EXIT-TEST: pthread_create failed rc=%d FAIL\n", rc);
      return 1;
    }
    /* stagger so threads actually reach their exit/__unmapself path */
    usleep(20000);
  }
  usleep(200000);
  printf("PTHREAD-EXIT-TEST: spawned+exited %d detached threads OK\n", N);
  fflush(stdout);
  return 0;
}
