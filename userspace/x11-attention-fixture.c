/* Small X11 client for end-to-end WM_HINTS urgency acceptance. */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdbool.h>
#include <stdio.h>
#include <sys/select.h>
#include <time.h>

static void set_urgent(Display *display, Window window, bool urgent) {
  XWMHints *hints = XGetWMHints(display, window);
  if (!hints) hints = XAllocWMHints();
  if (!hints) return;
  if (urgent) hints->flags |= XUrgencyHint;
  else hints->flags &= ~XUrgencyHint;
  XSetWMHints(display, window, hints);
  XFree(hints);
  XFlush(display);
}

int main(void) {
  Display *display = XOpenDisplay(NULL);
  if (!display) {
    fprintf(stderr, "x11-attention-fixture: X display unavailable\n");
    return 1;
  }
  int screen = DefaultScreen(display);
  Window window = XCreateSimpleWindow(display, RootWindow(display, screen),
                                     80, 80, 420, 160, 1,
                                     BlackPixel(display, screen),
                                     WhitePixel(display, screen));
  XStoreName(display, window, "X11 attention test");
  XSelectInput(display, window, ExposureMask | FocusChangeMask);
  XMapWindow(display, window);
  XFlush(display);
  struct timespec started;
  clock_gettime(CLOCK_MONOTONIC, &started);
  bool focused = false;
  bool requested = false;
  for (;;) {
    while (XPending(display)) {
      XEvent event;
      XNextEvent(display, &event);
      if (event.type == Expose && event.xexpose.count == 0) {
        GC gc = DefaultGC(display, screen);
        static const char first[] = "Focus another window. Urgency arrives after 8 seconds.";
        static const char second[] = "Focus this window again to clear attention.";
        XDrawString(display, window, gc, 24, 55, first, sizeof(first) - 1);
        XDrawString(display, window, gc, 24, 90, second, sizeof(second) - 1);
      } else if (event.type == FocusIn) {
        focused = true;
        if (requested) set_urgent(display, window, false);
      } else if (event.type == FocusOut) {
        focused = false;
      }
    }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (!requested && !focused && now.tv_sec - started.tv_sec >= 8) {
      requested = true;
      set_urgent(display, window, true);
      puts("x11-attention-fixture: requested WM_HINTS urgency");
      fflush(stdout);
    }
    fd_set readers;
    FD_ZERO(&readers);
    FD_SET(ConnectionNumber(display), &readers);
    struct timeval timeout = { .tv_sec = 0, .tv_usec = 250000 };
    select(ConnectionNumber(display) + 1, &readers, NULL, NULL, &timeout);
  }
}
