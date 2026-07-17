#ifndef Z_EXAMPLE_CALLBACKS_H
#define Z_EXAMPLE_CALLBACKS_H

#include <stdint.h>

typedef int32_t (*BinaryOperation)(int32_t left, int32_t right);
typedef int32_t (*UnaryOperation)(int32_t value, void *context);
typedef void (*ReleaseOperation)(void *context);

static UnaryOperation escapedOperation = 0;
static void *escapedContext = 0;
static ReleaseOperation escapedRelease = 0;

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

static inline void retainOperation(
  UnaryOperation operation,
  void *context,
  ReleaseOperation release
) {
  escapedOperation = operation;
  escapedContext = context;
  escapedRelease = release;
}

static inline int32_t invokeRetainedOperation(int32_t value) {
  return escapedOperation ? escapedOperation(value, escapedContext) : -1;
}

static inline void clearRetainedOperation(void) {
  ReleaseOperation release = escapedRelease;
  void *context = escapedContext;
  escapedOperation = 0;
  escapedContext = 0;
  escapedRelease = 0;
  if (release) release(context);
}

#endif
