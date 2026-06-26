/* pcctl.c — guest-side agent for pc's /Ctl desktop-control bridge over AF_VSOCK
 * (issue #60 Phase 2 / nix-wasm#10 option 3).
 *
 * This is the standard-socket replacement for the bespoke 9P `/Ctl` mount. The
 * old model surfaced `/Ctl/open`, `/Ctl/clipboard`, `/Ctl/notify` as files on
 * the 9P export, so the guest drove the desktop with plain redirection
 * (`echo calc > /mnt/pc/Ctl/open`). vsock is a byte STREAM, not a file tree, so
 * the guest needs a tiny client that frames the request itself — this program.
 *
 * It opens a SOCK_STREAM AF_VSOCK socket, connects to the host
 * (VMADDR_CID_HOST = 2) on CTL_PORT, sends one length-prefixed request, reads the
 * one length-prefixed reply, and exits. No fork, no threads — just
 * socket/connect/read/write/close, so it links clean under the NOMMU
 * posix_spawn-only musl (the `fork`/`vfork` symbols are removed at the libc
 * level; nothing here references them).
 *
 * WIRE PROTOCOL (authoritative definition: pc `js/linux/ctl-vsock.js`):
 *   request : "<VERB> <payloadLen>\n" + <payloadLen> bytes payload
 *   reply   : "<OK|ERR> <payloadLen>\n" + <payloadLen> bytes payload
 * The header line is ASCII up to the first '\n'; the payload that follows is
 * binary-safe (length-prefixed). A connection is one-shot here (one request,
 * one reply) — the host protocol also allows pipelining, which we don't need.
 *
 *   VERB     request payload          reply payload
 *   OPEN     app id OR a path         (empty)        — launch app / open path
 *   NOTIFY   notification text        (empty)        — post a desktop toast
 *   CLIPGET  (empty)                  clipboard text — read pc's clipboard
 *   CLIPSET  new clipboard text       (empty)        — set pc's clipboard
 *
 * Usage:
 *   pcctl open    <app-or-path>
 *   pcctl notify  <text>
 *   pcctl clipget
 *   pcctl clipset <text>      (empty text clears the clipboard)
 *
 * On an OK reply we exit 0 (CLIPGET first writes the clipboard payload + a
 * newline to stdout). On an ERR reply we write the host's message to stderr and
 * exit 1. The host port is CTL_PORT (1024) by default; override with the
 * PCCTL_PORT env var (handy for the node smoke without a rebuild). */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif

/* The fixed well-known host vsock port. MUST match pc js/linux/ctl-vsock.js
 * (CTL_PORT). The host device accepts any port; pc and this agent agree on it. */
#define CTL_PORT 1024

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
    if (r == 0) return -1; /* premature EOF */
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

/* Read the reply header line "<status> <len>\n" one byte at a time (it is short
 * and we must not over-read into the payload). Fills `status` and `*len`. */
static int read_header(int fd, char *status, size_t status_sz, long *len) {
  char line[64];
  size_t i = 0;
  for (;;) {
    char ch;
    ssize_t r = read(fd, &ch, 1);
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (r == 0) return -1; /* EOF before '\n' */
    if (ch == '\n') break;
    if (i < sizeof(line) - 1) line[i++] = ch;
  }
  line[i] = '\0';
  char *sp = strchr(line, ' ');
  if (!sp) return -1;
  *sp = '\0';
  /* Copy the status token ("OK"/"ERR") with explicit truncation — the token is
   * short, but bound it so the small `status` buffer can never overflow. */
  size_t tlen = strlen(line);
  if (tlen >= status_sz) tlen = status_sz - 1;
  memcpy(status, line, tlen);
  status[tlen] = '\0';
  errno = 0;
  char *end = NULL;
  long v = strtol(sp + 1, &end, 10);
  if (errno != 0 || end == sp + 1 || v < 0) return -1;
  *len = v;
  return 0;
}

/* Map a subcommand to its uppercase wire VERB and whether it takes an argument.
 * Returns the VERB, or NULL on an unknown subcommand. */
static const char *verb_for(const char *cmd, int *needs_arg) {
  if (strcmp(cmd, "open") == 0) {
    *needs_arg = 1;
    return "OPEN";
  }
  if (strcmp(cmd, "notify") == 0) {
    *needs_arg = 1;
    return "NOTIFY";
  }
  if (strcmp(cmd, "clipget") == 0) {
    *needs_arg = 0;
    return "CLIPGET";
  }
  if (strcmp(cmd, "clipset") == 0) {
    *needs_arg = 1; /* arg required, but may be the empty string (clears) */
    return "CLIPSET";
  }
  return NULL;
}

static void usage(void) {
  fprintf(stderr,
          "usage: pcctl <open|notify|clipget|clipset> [arg]\n"
          "  pcctl open    <app-or-path>\n"
          "  pcctl notify  <text>\n"
          "  pcctl clipget\n"
          "  pcctl clipset <text>\n");
}

int main(int argc, char **argv) {
  if (argc < 2) {
    usage();
    return 2;
  }
  int needs_arg = 0;
  const char *verb = verb_for(argv[1], &needs_arg);
  if (!verb) {
    fprintf(stderr, "pcctl: unknown command '%s'\n", argv[1]);
    usage();
    return 2;
  }
  /* CLIPGET takes no argument; the others require one (clipset's may be ""). */
  const char *payload = "";
  int is_clipget = (strcmp(verb, "CLIPGET") == 0);
  if (needs_arg) {
    if (argc < 3) {
      fprintf(stderr, "pcctl: '%s' needs an argument\n", argv[1]);
      usage();
      return 2;
    }
    payload = argv[2];
  } else if (argc > 2) {
    fprintf(stderr, "pcctl: '%s' takes no argument\n", argv[1]);
    usage();
    return 2;
  }
  size_t payload_len = strlen(payload);

  unsigned int port = CTL_PORT;
  const char *port_env = getenv("PCCTL_PORT");
  if (port_env && *port_env) {
    long p = strtol(port_env, NULL, 10);
    if (p > 0 && p < 65536) port = (unsigned int)p;
  }

  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) {
    perror("pcctl: socket(AF_VSOCK)");
    return 1;
  }

  struct sockaddr_vm addr;
  memset(&addr, 0, sizeof(addr));
  addr.svm_family = AF_VSOCK;
  addr.svm_cid = VMADDR_CID_HOST; /* 2 — the host (pc) */
  addr.svm_port = port;
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    perror("pcctl: connect to host /Ctl");
    close(fd);
    return 1;
  }

  /* Frame + send the request: "<VERB> <len>\n" + payload. */
  char hdr[64];
  int hn = snprintf(hdr, sizeof(hdr), "%s %zu\n", verb, payload_len);
  if (hn < 0 || (size_t)hn >= sizeof(hdr) || write_all(fd, hdr, (size_t)hn) != 0 ||
      (payload_len && write_all(fd, payload, payload_len) != 0)) {
    fprintf(stderr, "pcctl: short write to host\n");
    close(fd);
    return 1;
  }

  /* Read the one reply. */
  char status[16];
  long rlen = 0;
  if (read_header(fd, status, sizeof(status), &rlen) != 0) {
    fprintf(stderr, "pcctl: malformed reply from host\n");
    close(fd);
    return 1;
  }
  char *body = NULL;
  if (rlen > 0) {
    body = malloc((size_t)rlen);
    if (!body || read_all(fd, body, (size_t)rlen) != 0) {
      fprintf(stderr, "pcctl: short read of reply payload\n");
      free(body);
      close(fd);
      return 1;
    }
  }
  close(fd);

  int ok = (strcmp(status, "OK") == 0);
  if (!ok) {
    /* ERR — surface the host's message on stderr. */
    fprintf(stderr, "pcctl: host error: %.*s\n", (int)rlen, body ? body : "");
    free(body);
    return 1;
  }
  /* OK — CLIPGET prints the clipboard payload (+ newline); others are silent. */
  if (is_clipget) {
    if (rlen > 0) {
      if (write_all(1, body, (size_t)rlen) != 0) {
        free(body);
        return 1;
      }
    }
    if (write_all(1, "\n", 1) != 0) {
      free(body);
      return 1;
    }
  }
  free(body);
  return 0;
}
