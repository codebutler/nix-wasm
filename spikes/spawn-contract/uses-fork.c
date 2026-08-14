#include <unistd.h>
int main(void) { return fork(); }   /* must FAIL to link */
