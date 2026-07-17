#ifndef Z_EXAMPLE_CALLBACKS_H
#define Z_EXAMPLE_CALLBACKS_H

#include <stdint.h>

typedef int32_t (*BinaryOperation)(int32_t left, int32_t right);
typedef int32_t (*UnaryOperation)(int32_t value, void *context);

static inline int32_t apply(
  int32_t left,
  int32_t right,
  BinaryOperation operation
) {
  return operation(left, right);
}

static inline int32_t applyWithContext(
  int32_t value,
  void *context,
  UnaryOperation operation
) {
  return operation(value, context);
}

#endif
