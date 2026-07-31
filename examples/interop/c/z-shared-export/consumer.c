#include "zshared.h"

#include <stdint.h>
#include <stdio.h>

int main(void) {
  if (zshared_runtime_initialize(NULL) != ZSHARED_RUNTIME_OK) return 2;
  const int32_t answer = z_shared_add(20, 22);
  printf("shared=%d\n", answer);
  if (zshared_runtime_shutdown() != ZSHARED_RUNTIME_OK) return 3;
  return answer == 42 ? 0 : 1;
}
