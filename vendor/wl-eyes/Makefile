# wl-eyes — native Wayland client
#
# Generates the xdg-shell protocol glue with wayland-scanner from the system
# wayland-protocols package, then builds a single `wl-eyes` binary.

WAYLAND_PROTOCOLS := $(shell pkg-config --variable=pkgdatadir wayland-protocols)
WAYLAND_SCANNER   := $(shell pkg-config --variable=wayland_scanner wayland-scanner)
XDG_SHELL_XML     := $(WAYLAND_PROTOCOLS)/stable/xdg-shell/xdg-shell.xml

CFLAGS  += -O2 -Wall -Wextra -Wno-unused-parameter -Igenerated $(shell pkg-config --cflags wayland-client)
LDLIBS  += $(shell pkg-config --libs wayland-client) -lm

GENERATED := generated/xdg-shell-client-protocol.h generated/xdg-shell-protocol.c
SRC       := src/eyes.c generated/xdg-shell-protocol.c

wl-eyes: $(GENERATED) $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDLIBS)

generated/xdg-shell-client-protocol.h: $(XDG_SHELL_XML)
	@mkdir -p generated
	$(WAYLAND_SCANNER) client-header $< $@

generated/xdg-shell-protocol.c: $(XDG_SHELL_XML)
	@mkdir -p generated
	$(WAYLAND_SCANNER) private-code $< $@

clean:
	rm -rf generated wl-eyes

.PHONY: clean
