#include "zmath.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
  const int32_t sum = z_math_add(20, 22);
  const int32_t answer = z_math_answer();
  const bool even = z_math_is_even(answer);

  printf("sum=%d answer=%d even=%s\n", sum, answer, even ? "true" : "false");
  return sum == 42 && answer == 42 && even ? 0 : 1;
}
