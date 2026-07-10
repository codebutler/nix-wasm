/* fork-pipe.c — Phase 2: fd inheritance + parent/child IPC across fork().
 *
 * The parent creates a pipe, fork()s, the child writes a message into the pipe
 * and exits, the parent reads it back. This checks two core fork semantics the
 * matrix hadn't: the child inherits the parent's open file descriptors (the
 * kernel copied the fd table at fork), and a real-kernel pipe carries data
 * between the two separate workers. Built with the musl-fork seam; baked in as
 * /bin/fork-pipe.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  int fd[2];
  if (pipe(fd) != 0) {
    printf("FORKPIPE pipe() failed\n");
    fflush(stdout);
    return 1;
  }
  pid_t p = fork();
  if (p == 0) {
    close(fd[0]);
    const char *msg = "PIPED_FROM_CHILD";
    write(fd[1], msg, strlen(msg));
    close(fd[1]);
    _exit(0);
  }
  close(fd[1]);
  char buf[64];
  int n = (int)read(fd[0], buf, sizeof(buf) - 1);
  if (n < 0) n = 0;
  buf[n] = 0;
  int st = 0;
  waitpid(p, &st, 0);
  printf("FORKPIPE parent read=[%s] cexit=%d\n", buf, WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  fflush(stdout);
  return 0;
}
