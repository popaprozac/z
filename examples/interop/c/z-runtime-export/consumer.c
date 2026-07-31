#include "zembed.h"

#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_condition = PTHREAD_COND_INITIALIZER;
static bool entered = false;
static bool released = false;

void z_runtime_host_entered(void) {
  pthread_mutex_lock(&gate_mutex);
  entered = true;
  pthread_cond_broadcast(&gate_condition);
  pthread_mutex_unlock(&gate_mutex);
}

void z_runtime_host_wait(void) {
  pthread_mutex_lock(&gate_mutex);
  while (!released) pthread_cond_wait(&gate_condition, &gate_mutex);
  pthread_mutex_unlock(&gate_mutex);
}

static void *call_z_from_native_thread(void *context) {
  int32_t *result = (int32_t *)context;
  *result = z_embed_hold(42);
  return NULL;
}

int main(void) {
  if (zembed_runtime_initialize(NULL) != ZEMBED_RUNTIME_OK) return 1;

  int32_t result = 0;
  pthread_t worker;
  if (pthread_create(&worker, NULL, call_z_from_native_thread, &result) != 0) return 2;

  pthread_mutex_lock(&gate_mutex);
  while (!entered) pthread_cond_wait(&gate_condition, &gate_mutex);
  pthread_mutex_unlock(&gate_mutex);

  const zembed_runtime_status busy = zembed_runtime_shutdown();

  pthread_mutex_lock(&gate_mutex);
  released = true;
  pthread_cond_broadcast(&gate_condition);
  pthread_mutex_unlock(&gate_mutex);

  if (pthread_join(worker, NULL) != 0) return 3;
  const zembed_runtime_status stopped = zembed_runtime_shutdown();

  printf("busy=%d result=%d stopped=%d\n", busy, result, stopped);
  return busy == ZEMBED_RUNTIME_BUSY
    && result == 42
    && stopped == ZEMBED_RUNTIME_OK
    ? 0
    : 4;
}
