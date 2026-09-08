#ifndef Z_TEST_ASYNC_WORKER_SCOPE_H
#define Z_TEST_ASYNC_WORKER_SCOPE_H
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static pthread_t host_thread;
static pthread_mutex_t probe_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t probe_condition = PTHREAD_COND_INITIALIZER;
static int entered_count;
static int released_count;
static int published_count;

static inline void initialize(void) { host_thread = pthread_self(); }
static inline void listener_entered(void) {
  if (pthread_equal(pthread_self(), host_thread)) abort();
  pthread_mutex_lock(&probe_mutex);
  entered_count += 1;
  pthread_cond_broadcast(&probe_condition);
  pthread_mutex_unlock(&probe_mutex);
}
static inline void listener_released(void) {
  if (pthread_equal(pthread_self(), host_thread)) abort();
  pthread_mutex_lock(&probe_mutex);
  released_count += 1;
  pthread_mutex_unlock(&probe_mutex);
}
static inline void reset_entry(void) {
  pthread_mutex_lock(&probe_mutex);
  entered_count = 0;
  pthread_mutex_unlock(&probe_mutex);
}
static inline void wait_for_entry(void) {
  pthread_mutex_lock(&probe_mutex);
  while (entered_count == 0) pthread_cond_wait(&probe_condition, &probe_mutex);
  pthread_mutex_unlock(&probe_mutex);
}
static inline void publish_on_main(void) {
  if (!pthread_equal(pthread_self(), host_thread)) abort();
  published_count += 1;
}
static inline int verify(void) {
  const int valid = released_count == 2 && published_count == 2;
  if (valid) puts("workers joined; resources released; wakes published on main");
  return valid ? 0 : 2;
}
#endif
