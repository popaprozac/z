#ifndef Z_CALLBACK_FAILURE_H
#define Z_CALLBACK_FAILURE_H

#include <stdint.h>

typedef enum ZVisitStatus {
  Z_VISIT_OK = 0,
  Z_VISIT_ABORTED = 101,
} ZVisitStatus;

typedef int32_t (*ZRowVisitor)(int32_t row, void *context);

static inline ZVisitStatus z_visit_rows(void *context, ZRowVisitor visitor) {
  for (int32_t row = 1; row <= 3; row += 1) {
    if (visitor(row, context) != 0) return Z_VISIT_ABORTED;
  }
  return Z_VISIT_OK;
}

#endif
