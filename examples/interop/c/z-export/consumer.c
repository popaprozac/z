#include "zmath.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
  const int32_t sum = z_math_add(20, 22);
  const int32_t answer = z_math_answer();
  const bool even = z_math_is_even(answer);
  const ZMathPoint translated = z_math_translate(
    (ZMathPoint){ .x = 20, .y = 21 },
    1,
    1
  );

  printf(
    "sum=%d answer=%d even=%s point=(%d,%d)\n",
    sum,
    answer,
    even ? "true" : "false",
    translated.x,
    translated.y
  );
  return sum == 42
    && answer == 42
    && even
    && translated.x == 21
    && translated.y == 22
    ? 0
    : 1;
}
