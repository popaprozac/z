#ifndef Z_TEST_CALLBACKS_ANY_THREAD_H
#define Z_TEST_CALLBACKS_ANY_THREAD_H

#include <pthread.h>
#include <stdint.h>

typedef int32_t (*ZAnyThreadCallback)(int32_t value, void *context);
typedef void (*ZAnyThreadRelease)(void *context);

static pthread_t z_any_thread;
static ZAnyThreadCallback z_any_callback = 0;
static void *z_any_context = 0;
static ZAnyThreadRelease z_any_release = 0;
static int32_t z_any_value = 0;
static int32_t z_any_result = 0;
static int z_any_started = 0;

static inline void *z_any_thread_entry(void *unused) {
  (void)unused;
  z_any_result = z_any_callback(z_any_value, z_any_context);
  z_any_release(z_any_context);
  z_any_callback = 0;
  z_any_context = 0;
  z_any_release = 0;
  return 0;
}

static inline void z_start_any_thread_callback(
  int32_t value,
  ZAnyThreadCallback callback,
  void *context,
  ZAnyThreadRelease release
) {
  z_any_value = value;
  z_any_callback = callback;
  z_any_context = context;
  z_any_release = release;
  if (pthread_create(&z_any_thread, 0, z_any_thread_entry, 0) != 0) {
    z_any_callback = 0;
    z_any_context = 0;
    z_any_release = 0;
    release(context);
    z_any_result = -1;
  } else {
    z_any_started = 1;
  }
}

static inline int32_t z_join_any_thread_callback(void) {
  if (z_any_started) {
    pthread_join(z_any_thread, 0);
    z_any_started = 0;
  }
  return z_any_result;
}

#endif
