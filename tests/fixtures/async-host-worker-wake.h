#ifndef Z_TEST_ASYNC_HOST_WORKER_WAKE_H
#define Z_TEST_ASYNC_HOST_WORKER_WAKE_H
#include <CoreFoundation/CoreFoundation.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_condition = PTHREAD_COND_INITIALIZER;
static bool gate_open;
static int32_t delivered;
static int32_t delivery_count;

static inline int32_t z_test_wait_for_host(void) {
  pthread_mutex_lock(&gate_mutex);
  while (!gate_open) pthread_cond_wait(&gate_condition, &gate_mutex);
  pthread_mutex_unlock(&gate_mutex);
  return 42;
}

static inline void z_test_deliver(int32_t value) {
  if (!pthread_main_np()) __builtin_abort();
  delivered = value;
  delivery_count += 1;
  CFRunLoopStop(CFRunLoopGetMain());
}

static inline void z_test_release_worker(void) {
  pthread_mutex_lock(&gate_mutex);
  gate_open = true;
  pthread_cond_signal(&gate_condition);
  pthread_mutex_unlock(&gate_mutex);
}

static inline int32_t z_test_run_host(void) {
  z_test_release_worker();
  // No second task, user input, or polling timer may rescue the completion.
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.5, false);
  return delivered;
}
#endif
