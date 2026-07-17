#ifndef Z_TEST_CALLBACKS_H
#define Z_TEST_CALLBACKS_H

#include <stdint.h>

typedef int32_t (*ZBinaryCallback)(int32_t left, int32_t right);

static inline int32_t z_apply_i32(int32_t left, int32_t right, ZBinaryCallback callback) {
  return callback(left, right);
}

static inline int32_t z_apply_twice_i32(int32_t value, ZBinaryCallback callback) {
  return callback(callback(value, 1), 1);
}

static inline void z_store_callback(ZBinaryCallback callback) {
  (void)callback;
}

#endif
