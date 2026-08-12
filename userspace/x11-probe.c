/* x11-probe — M-X2 client/server protocol proof (XChat/X11 epic). Connects
 * to $DISPLAY via libxcb, reads the connection setup reply (vendor string +
 * the first screen's dimensions), and prints a single machine-parseable
 * line. This is the "does a real X11 client talk to our cross-built Xvfb
 * over the wire protocol" gate — zero toolkit involvement (no Xlib, no GTK),
 * just libxcb, the smallest possible client stack.
 *
 * PASS:    X11-PROBE: vendor=<vendor string> screen=<W>x<H> OK
 * FAILURE: X11-PROBE-FAIL: <reason>, exit 1.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <xcb/xcb.h>

int
main(void)
{
    xcb_connection_t *conn = xcb_connect(NULL, NULL);
    if (conn == NULL) {
        fprintf(stderr, "X11-PROBE-FAIL: xcb_connect returned NULL\n");
        return 1;
    }
    if (xcb_connection_has_error(conn)) {
        fprintf(stderr, "X11-PROBE-FAIL: connection error %d\n",
                xcb_connection_has_error(conn));
        xcb_disconnect(conn);
        return 1;
    }

    const xcb_setup_t *setup = xcb_get_setup(conn);
    if (setup == NULL) {
        fprintf(stderr, "X11-PROBE-FAIL: xcb_get_setup returned NULL\n");
        xcb_disconnect(conn);
        return 1;
    }

    int vendor_len = xcb_setup_vendor_length(setup);
    const char *vendor = xcb_setup_vendor(setup);
    char vendor_buf[256];
    int copy_len = vendor_len < (int) sizeof(vendor_buf) - 1
        ? vendor_len : (int) sizeof(vendor_buf) - 1;
    memcpy(vendor_buf, vendor, copy_len);
    vendor_buf[copy_len] = '\0';

    xcb_screen_iterator_t iter = xcb_setup_roots_iterator(setup);
    if (iter.rem == 0) {
        fprintf(stderr, "X11-PROBE-FAIL: no screens in setup reply\n");
        xcb_disconnect(conn);
        return 1;
    }
    xcb_screen_t *screen = iter.data;

    printf("X11-PROBE: vendor=%s screen=%ux%u OK\n",
           vendor_buf, (unsigned) screen->width_in_pixels,
           (unsigned) screen->height_in_pixels);

    xcb_disconnect(conn);
    return 0;
}
