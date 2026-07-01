// A second side module chained on the first: imports side.c's export.
extern int side_fn(int a, int b);   // resolved from the earlier side module
int side2_sum(int x) { return side_fn(x, x); }
