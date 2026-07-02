// FFI trampoline test targets. Built as a PIC dylink module + a fpcast'd
// variant so the tests can exercise both the raw and canonical trampoline ABIs
// against REAL wasm functions installed in a shared table.
int add(int a, int b) { return a + b; }
long long mulll(long long a, int b) { return a * b; }
double scaled(double x, double y) { return x * y + 1.0; }
float mixf(float a, float b) { return a * 2.0f + b; }
int sum10(int a,int b,int c,int d,int e,int f,int g,int h,int i,int j){return a+b+c+d+e+f+g+h+i+j;}
void store_sum(int *out, int a, int b) { *out = a + b; }
// address-taken so they land in the elem segment (fpcast thunks them)
int (*t_add)(int,int) = add;
long long (*t_mulll)(long long,int) = mulll;
double (*t_scaled)(double,double) = scaled;
float (*t_mixf)(float,float) = mixf;
int (*t_sum10)(int,int,int,int,int,int,int,int,int,int) = sum10;
void (*t_store_sum)(int*,int,int) = store_sum;
