/*
 * #179 hardening fixture. Built twice by userspace/exec-reject-test.nix:
 *   exec-ok-test     — as linked: a conforming guest image, must run to completion
 *   exec-reject-test — the same bytes with the `__get_tls_base` export removed,
 *                      which the software-MMU instrumentation pass must REFUSE
 *
 * Deliberately trivial: the point is the module's export surface, not what the
 * program does. It prints a marker and exits 0 so the smoke can tell "ran" from
 * "was rejected" without guessing at exit codes.
 */
#include <stdio.h>

int main(void)
{
	printf("EXEC-FIXTURE: ran OK\n");
	fflush(stdout);
	return 0;
}
