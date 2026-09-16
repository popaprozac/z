#include "shared_root.h"
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>

_Static_assert(SHARED_ROOT_RUNTIME_REQUIRES_MAIN_THREAD == 0, "no main-thread proof needed");
_Static_assert(SHARED_ROOT_RUNTIME_REQUIRES_ENQUEUE_RELEASE == 0, "no main release hook needed");

static void *initialize(void *unused) {
  (void)unused;
  return (void *)(uintptr_t)shared_root_runtime_initialize(NULL);
}

static void *increment(void *unused) {
  (void)unused;
  for (int i = 0; i < 10000; ++i) (void)shared_increment();
  return NULL;
}

static void *shutdown(void *unused) {
  (void)unused;
  return (void *)(uintptr_t)shared_root_runtime_shutdown();
}

int main(void) {
  pthread_t worker, first, second;
  void *status = NULL;
  if (pthread_create(&worker, NULL, initialize, NULL)) return 1;
  if (pthread_join(worker, &status) || (uintptr_t)status != SHARED_ROOT_RUNTIME_OK) return 2;
  if (pthread_create(&first, NULL, increment, NULL)) return 3;
  if (pthread_create(&second, NULL, increment, NULL)) return 4;
  if (pthread_join(first, NULL) || pthread_join(second, NULL)) return 5;
  if (shared_count() != 20000) return 6;
  if (pthread_create(&worker, NULL, shutdown, NULL)) return 7;
  if (pthread_join(worker, &status) || (uintptr_t)status != SHARED_ROOT_RUNTIME_OK) return 8;
  puts("worker-first lifecycle ok");
  return 0;
}
