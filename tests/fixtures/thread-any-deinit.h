#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

static pthread_t z_cleanup_main_thread;
static atomic_int z_cleanup_total;
static atomic_int z_cleanup_parent_count;
static atomic_int z_cleanup_worker_count;

static inline void z_cleanup_begin(void) {
  z_cleanup_main_thread = pthread_self();
  atomic_store(&z_cleanup_total, 0);
  atomic_store(&z_cleanup_parent_count, 0);
  atomic_store(&z_cleanup_worker_count, 0);
}

static inline void z_cleanup_record(int amount) {
  atomic_fetch_add(&z_cleanup_total, amount);
  if (pthread_equal(pthread_self(), z_cleanup_main_thread))
    atomic_fetch_add(&z_cleanup_parent_count, 1);
  else
    atomic_fetch_add(&z_cleanup_worker_count, 1);
}

static inline int z_cleanup_valid(void) {
  return atomic_load(&z_cleanup_total) == 53
    && atomic_load(&z_cleanup_parent_count) == 2
    && atomic_load(&z_cleanup_worker_count) == 1;
}

__attribute__((destructor)) static void z_cleanup_verify(void) {
  if (!z_cleanup_valid()) abort();
}
