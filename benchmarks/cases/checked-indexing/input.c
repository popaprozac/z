#include "input.h"
#include <errno.h>
#include <stdlib.h>

uintptr_t z_index_bench_width(void) {
  const char *text = getenv("Z_INDEX_WIDTH");
  if (text == NULL) return 4096;
  errno = 0;
  char *end = NULL;
  unsigned long long width = strtoull(text, &end, 10);
  if (errno || end == text || *end != '\0' || width < 1 || width > 1048576) abort();
  return (uintptr_t)width;
}
