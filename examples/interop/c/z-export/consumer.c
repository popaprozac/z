#include "zmath.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
  if (zmath_runtime_initialize(NULL) != ZMATH_RUNTIME_OK) return 2;
  if (zmath_runtime_initialize(NULL) != ZMATH_RUNTIME_ALREADY_INITIALIZED) return 3;

  const int32_t sum = z_math_add(20, 22);
  const int32_t answer = z_math_answer();
  const bool even = z_math_is_even(answer);
  const uintptr_t text_length = z_math_text_byte_length("h\xC3\xA9llo");
  const ZMathPoint translated = z_math_translate(
    (ZMathPoint){ .x = 20, .y = 21 },
    1,
    1
  );
  const ZMathStatus status = z_math_classify(answer);
  const int32_t status_code = z_math_status_code(status);

  printf(
    "sum=%d answer=%d even=%s text=%zu point=(%d,%d) status=%d\n",
    sum,
    answer,
    even ? "true" : "false",
    (size_t)text_length,
    translated.x,
    translated.y,
    status_code
  );
  const bool correct = sum == 42
    && answer == 42
    && even
    && text_length == 6
    && translated.x == 21
    && translated.y == 22
    && status == ZMathStatus_positive
    && status_code == 1;
  if (zmath_runtime_shutdown() != ZMATH_RUNTIME_OK) return 4;
  if (zmath_runtime_shutdown() != ZMATH_RUNTIME_SHUT_DOWN) return 5;
  return correct ? 0 : 1;
}
