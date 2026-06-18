CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Wno-unused-parameter
SRCS = $(wildcard *.c)
BINS = $(SRCS:.c=)

all: $(BINS)

%: %.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f $(BINS)

.PHONY: all clean
