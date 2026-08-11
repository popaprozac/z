#ifndef Z_TEST_SCALAR_POINTERS_H
#define Z_TEST_SCALAR_POINTERS_H

#include <stdint.h>

static inline uint32_t z_mouse_state(float *x, float *y) {
  *x = 12.5f;
  *y = 7.25f;
  return 3;
}

static inline int z_mouse_state_checked(float *x, float *y) {
  (void)z_mouse_state(x, y);
  return 0;
}

static inline void z_increment_float(float *value) {
  *value += 1.0f;
}

static inline float z_read_float(const float *value) {
  return *value;
}

#endif
