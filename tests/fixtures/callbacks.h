#ifndef Z_TEST_CALLBACKS_H
#define Z_TEST_CALLBACKS_H

#include <stdint.h>

typedef int32_t (*ZBinaryCallback)(int32_t left, int32_t right);
typedef int32_t (*ZContextCallback)(int32_t value, void *context);
typedef void (*ZContextRelease)(void *context);

static ZContextCallback z_escaped_callback = 0;
static void *z_escaped_context = 0;
static ZContextRelease z_escaped_release = 0;

static inline int32_t z_apply_i32(int32_t left, int32_t right, ZBinaryCallback callback) {
  return callback(left, right);
}

static inline int32_t z_apply_twice_i32(int32_t value, ZBinaryCallback callback) {
  return callback(callback(value, 1), 1);
}

static inline void z_store_callback(ZBinaryCallback callback) {
  (void)callback;
}

static inline int32_t z_apply_context_i32(int32_t value, void *context, ZContextCallback callback) {
  return callback(value, context);
}

static inline void z_register_context_callback(
  ZContextCallback callback,
  void *context,
  ZContextRelease release
) {
  z_escaped_callback = callback;
  z_escaped_context = context;
  z_escaped_release = release;
}

static inline int32_t z_invoke_context_callback(int32_t value) {
  return z_escaped_callback ? z_escaped_callback(value, z_escaped_context) : -1;
}

static inline void z_clear_context_callback(void) {
  ZContextRelease release = z_escaped_release;
  void *context = z_escaped_context;
  z_escaped_callback = 0;
  z_escaped_context = 0;
  z_escaped_release = 0;
  if (release) release(context);
}

#endif
