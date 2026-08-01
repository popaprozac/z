#include "zembed.h"

#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_condition = PTHREAD_COND_INITIALIZER;
static bool entered = false;
static bool released = false;
static int root_releases = 0;
static pthread_t main_thread;
static void *pending_release_value = NULL;
static void (*pending_release_finalize)(void *value) = NULL;

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

void z_runtime_host_released(void) {
  root_releases += 1;
}

static bool is_main_thread(void *context) {
  (void)context;
  return pthread_equal(pthread_self(), main_thread) != 0;
}

static void enqueue_main_release(
  void *context,
  void *value,
  void (*finalize)(void *value)
) {
  (void)context;
  if (pending_release_finalize != NULL) abort();
  pending_release_value = value;
  pending_release_finalize = finalize;
}

static void drain_main_release(void) {
  if (pending_release_finalize == NULL) return;
  void *value = pending_release_value;
  void (*finalize)(void *value) = pending_release_finalize;
  pending_release_value = NULL;
  pending_release_finalize = NULL;
  finalize(value);
}

typedef struct initialize_context {
  const zembed_runtime_config *config;
  zembed_runtime_status status;
} initialize_context;

static void *initialize_from_worker(void *opaque) {
  initialize_context *context = (initialize_context *)opaque;
  context->status = zembed_runtime_initialize(context->config);
  return NULL;
}

static void *call_z_from_native_thread(void *context) {
  int32_t *result = (int32_t *)context;
  *result = z_embed_complete_job(42);
  return NULL;
}

int main(void) {
  main_thread = pthread_self();
  const zembed_runtime_config config = {
    .context = NULL,
    .enqueue_release = enqueue_main_release,
    .is_main_thread = is_main_thread,
  };
  initialize_context initialization = {
    .config = &config,
    .status = ZEMBED_RUNTIME_OK,
  };
  pthread_t initializer;
  if (pthread_create(&initializer, NULL, initialize_from_worker, &initialization) != 0) return 1;
  if (pthread_join(initializer, NULL) != 0) return 2;
  if (initialization.status != ZEMBED_RUNTIME_WRONG_THREAD) return 3;
  if (zembed_runtime_initialize(&config) != ZEMBED_RUNTIME_OK) return 4;

  int32_t result = 0;
  pthread_t worker;
  if (pthread_create(&worker, NULL, call_z_from_native_thread, &result) != 0) return 5;

  pthread_mutex_lock(&gate_mutex);
  while (!entered) pthread_cond_wait(&gate_condition, &gate_mutex);
  pthread_mutex_unlock(&gate_mutex);

  const zembed_runtime_status busy = zembed_runtime_shutdown();

  pthread_mutex_lock(&gate_mutex);
  released = true;
  pthread_cond_broadcast(&gate_condition);
  pthread_mutex_unlock(&gate_mutex);

  if (pthread_join(worker, NULL) != 0) return 6;
  const int32_t checksum = z_embed_completion_checksum();
  const zembed_runtime_status draining = zembed_runtime_shutdown();
  drain_main_release();
  const zembed_runtime_status stopped = zembed_runtime_shutdown();

  printf(
    "wrong=%d busy=%d completed=%d checksum=%d draining=%d stopped=%d released=%d\n",
    initialization.status,
    busy,
    result,
    checksum,
    draining,
    stopped,
    root_releases
  );
  return initialization.status == ZEMBED_RUNTIME_WRONG_THREAD
    && busy == ZEMBED_RUNTIME_BUSY
    && result == 1
    && checksum == 43
    && draining == ZEMBED_RUNTIME_DRAINING
    && stopped == ZEMBED_RUNTIME_OK
    && root_releases == 1
    ? 0
    : 8;
}
