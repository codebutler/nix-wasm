/* fpcast-vtable-test — isolate hypotheses for the GTK render heap-corruption
 * crash (gtk-wayland-render-blocker). Two parts:
 *
 *  Part 1: does binaryen `--fpcast-emu` correctly dispatch function pointers that
 *  live in STATIC CONST data (rodata), resolved by the wasm dylink loader's DATA
 *  RELOCATIONS? This is exactly GtkCssValue's pattern (`value->class->method()`
 *  where class is a file-scope `static const GtkCssValueClass`), the one thing
 *  GTK's CSS draw path does that the passing selftests / pango / wl-anim do not.
 *
 *  Part 2: widen fpcast coverage to the signature classes GTK's draw path
 *  dispatches through fn pointers — double args/returns, pointer args, wide arity
 *  (the fpcast canonical sig is (i64x128)->i64; floats/doubles must be correctly
 *  reinterpreted in the thunks, which Part 1's all-int test never exercised).
 *
 * All fn pointers are laundered through `volatile` so the optimizer cannot
 * devirtualize the indirect call back to a direct one (GtkCssValue pointers are
 * likewise opaque). PASS (...OK) => fpcast is correct for these patterns =>
 * hypothesis REFUTED. FAIL (...FAIL / wrong dispatch) => smoking gun; the fix is
 * in the shared fpcast seam.
 */
#include <stdio.h>

/* ---- Part 1: rodata static-const vtable dispatch (GtkCssValue pattern) ---- */

typedef struct VClass VClass;
struct VClass {
  int (*get_id)(const VClass *self);
  const char *name;
};

static int id_shadows(const VClass *s) { (void)s; return 1001; }
static int id_color(const VClass *s)   { (void)s; return 1002; }
static int id_number(const VClass *s)  { (void)s; return 1003; }
static int id_string(const VClass *s)  { (void)s; return 1004; }
static int id_border(const VClass *s)  { (void)s; return 1005; }
static int id_image(const VClass *s)   { (void)s; return 1006; }
static int id_shorthand(const VClass *s) { (void)s; return 1007; }
static int id_array(const VClass *s)   { (void)s; return 1008; }

static const VClass CLASS_SHADOWS   = { id_shadows,   "shadows"   };
static const VClass CLASS_COLOR     = { id_color,     "color"     };
static const VClass CLASS_NUMBER    = { id_number,    "number"    };
static const VClass CLASS_STRING    = { id_string,    "string"    };
static const VClass CLASS_BORDER    = { id_border,    "border"    };
static const VClass CLASS_IMAGE     = { id_image,     "image"     };
static const VClass CLASS_SHORTHAND = { id_shorthand, "shorthand" };
static const VClass CLASS_ARRAY     = { id_array,     "array"     };

typedef struct { const VClass *class; } Value;

/* gobject's arity-mismatch cast (the reason the fpcast seam exists) */
typedef void (*Func2)(int, int);
static volatile int g_sink = 0;
static void onearg(int x) { g_sink += x; }

static const VClass *volatile g_opaque;

/* ---- Part 2: varied-signature fn pointers dispatched through fpcast ---- */

typedef double (*Fd)(double, double);
typedef int (*Fp)(const int *, int);
typedef double (*Fwide)(int, int, int, int, int, int, int, int, double, double);

static double dadd(double a, double b) { return a + b; }
static int padd(const int *p, int k) { return *p + k; }
static double wide(int a, int b, int c, int d, int e, int f, int g, int h,
                   double x, double y) {
  return (double)(a + b + c + d + e + f + g + h) + x + y;
}

static volatile Fd g_fd;
static volatile Fp g_fp;
static volatile Fwide g_fwide;

int main(void) {
  Func2 f2 = (Func2)onearg;
  f2(7, 99); /* engage --fpcast-emu */

  const VClass *classes[] = {
    &CLASS_SHADOWS, &CLASS_COLOR, &CLASS_NUMBER, &CLASS_STRING,
    &CLASS_BORDER, &CLASS_IMAGE, &CLASS_SHORTHAND, &CLASS_ARRAY,
  };
  int expect[] = { 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008 };
  int n = (int)(sizeof(classes) / sizeof(classes[0]));

  int wrong = 0, tagbad = 0;
  for (int i = 0; i < n; i++) {
    g_opaque = classes[i];
    const VClass *c = g_opaque;
    Value v;
    v.class = c;
    if (v.class != classes[i]) tagbad++;
    int got = v.class->get_id(v.class); /* rodata fn ptr -> call_indirect */
    int ok = (got == expect[i]);
    if (!ok) wrong++;
    printf("FPCAST-VTABLE case %d (%-9s): got=%d expect=%d %s\n",
           i, c->name, got, expect[i], ok ? "ok" : "WRONG");
  }

  /* Part 2 */
  int wrong2 = 0;

  g_fd = dadd;
  double rd = g_fd(2.5, 4.0);
  if (rd != 6.5) wrong2++;
  printf("FPCAST-VTABLE dbl  : got=%.3f expect=6.500 %s\n", rd, rd == 6.5 ? "ok" : "WRONG");

  int base = 40;
  g_fp = padd;
  int rp = g_fp(&base, 2);
  if (rp != 42) wrong2++;
  printf("FPCAST-VTABLE ptr  : got=%d expect=42 %s\n", rp, rp == 42 ? "ok" : "WRONG");

  g_fwide = wide;
  double rw = g_fwide(1, 2, 3, 4, 5, 6, 7, 8, 1.5, 2.5);
  if (rw != 40.0) wrong2++;
  printf("FPCAST-VTABLE wide : got=%.3f expect=40.000 %s\n", rw, rw == 40.0 ? "ok" : "WRONG");

  int fail = (wrong != 0 || tagbad != 0 || wrong2 != 0);
  printf("FPCAST-VTABLE-TEST: cases=%d wrong=%d tagbad=%d wrong2=%d sink=%d %s\n",
         n, wrong, tagbad, wrong2, g_sink, fail ? "FAIL" : "OK");
  return fail ? 1 : 0;
}
