#include <spawn.h>
#include <unistd.h>
extern char **environ;
int main(void) {
    pid_t pid; char *argv[] = {"/bin/true", 0};
    return posix_spawn(&pid, "/bin/true", 0, 0, argv, environ);  /* must link */
}
