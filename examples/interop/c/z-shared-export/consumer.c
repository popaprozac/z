#include "zshared.h"

#include <stdint.h>
#include <stdio.h>

int main(void) {
  const int32_t answer = z_shared_add(20, 22);
  printf("shared=%d\n", answer);
  return answer == 42 ? 0 : 1;
}
