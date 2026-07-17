#ifndef Z_EXAMPLE_CALLBACKS_H
#define Z_EXAMPLE_CALLBACKS_H

#include <stdint.h>

typedef int32_t (*BinaryOperation)(int32_t left, int32_t right);

static inline int32_t apply(
  int32_t left,
  int32_t right,
  BinaryOperation operation
) {
  return operation(left, right);
}

#endif
