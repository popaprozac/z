#ifndef Z_EXAMPLE_NATIVE_CALLBACK_H
#define Z_EXAMPLE_NATIVE_CALLBACK_H

#include <pthread.h>
#include <stdint.h>

typedef int32_t (*ZNativeCalculation)(int32_t value, void *context);
typedef void (*ZNativeCalculationRelease)(void *context);

static pthread_t z_example_thread;
static ZNativeCalculation z_example_calculation = 0;
static void *z_example_context = 0;
static ZNativeCalculationRelease z_example_release = 0;
static int32_t z_example_input = 0;
static int32_t z_example_result = 0;
static int z_example_started = 0;

static inline void *z_example_calculate(void *unused) {
  (void)unused;
  z_example_result = z_example_calculation(z_example_input, z_example_context);
  z_example_release(z_example_context);
  z_example_calculation = 0;
  z_example_context = 0;
  z_example_release = 0;
  return 0;
}

static inline void z_example_start_calculation(
  int32_t input,
  ZNativeCalculation calculation,
  void *context,
  ZNativeCalculationRelease release
) {
  z_example_input = input;
  z_example_calculation = calculation;
  z_example_context = context;
  z_example_release = release;
  if (pthread_create(&z_example_thread, 0, z_example_calculate, 0) != 0) {
    z_example_calculation = 0;
    z_example_context = 0;
    z_example_release = 0;
    release(context);
    z_example_result = -1;
  } else {
    z_example_started = 1;
  }
}

static inline int32_t z_example_join_calculation(void) {
  if (z_example_started) {
    pthread_join(z_example_thread, 0);
    z_example_started = 0;
  }
  return z_example_result;
}

#endif
