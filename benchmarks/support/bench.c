#include "bench.h"

#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#if defined(__GNUC__) || defined(__clang__)
#define Z_BENCH_NOINLINE __attribute__((noinline))
#else
#define Z_BENCH_NOINLINE
#endif

static volatile uint64_t z_bench_sink = 0;
static _Atomic uint64_t z_bench_allocation_count = 0;
static _Atomic uint64_t z_bench_free_count = 0;
static _Atomic uint64_t z_bench_requested_bytes = 0;
static int z_bench_initialized = 0;
static int z_bench_track_allocations = 0;

static void z_bench_report_allocations(void) {
  if (!z_bench_track_allocations) return;
  printf(
    "ALLOC %llu %llu %llu\n",
    (unsigned long long)atomic_load_explicit(&z_bench_allocation_count, memory_order_relaxed),
    (unsigned long long)atomic_load_explicit(&z_bench_free_count, memory_order_relaxed),
    (unsigned long long)atomic_load_explicit(&z_bench_requested_bytes, memory_order_relaxed)
  );
}

static void z_bench_initialize(void) {
  if (z_bench_initialized) return;
  z_bench_initialized = 1;
  const char *tracking = getenv("Z_BENCH_TRACK_ALLOCATIONS");
  z_bench_track_allocations = tracking != NULL && tracking[0] == '1';
  if (atexit(z_bench_report_allocations) != 0) abort();
}

uint64_t z_bench_iterations(void) {
  z_bench_initialize();
  const char *configured = getenv("Z_BENCH_ITERATIONS");
  if (configured == NULL || configured[0] == '\0') return 1000000;
  errno = 0;
  char *end = NULL;
  const unsigned long long parsed = strtoull(configured, &end, 10);
  if (errno != 0 || end == configured || *end != '\0' || parsed == 0) abort();
  return (uint64_t)parsed;
}

uint64_t z_bench_now_ns(void) {
  struct timespec value;
#if defined(CLOCK_MONOTONIC_RAW)
  if (clock_gettime(CLOCK_MONOTONIC_RAW, &value) != 0) abort();
#else
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) abort();
#endif
  return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

Z_BENCH_NOINLINE uint64_t z_bench_mix(uint64_t value) {
  value ^= value >> 30;
  value *= UINT64_C(0xbf58476d1ce4e5b9);
  value ^= value >> 27;
  value *= UINT64_C(0x94d049bb133111eb);
  return value ^ (value >> 31);
}

Z_BENCH_NOINLINE void z_bench_drop(uint64_t value) {
  z_bench_sink ^= value;
}

Z_BENCH_NOINLINE void z_bench_consume_u64(uint64_t value) {
  z_bench_sink = value;
}

void z_bench_report(const char *name, uint64_t nanoseconds, uint64_t checksum) {
  z_bench_consume_u64(checksum);
  printf(
    "RESULT %s %llu %llu\n",
    name,
    (unsigned long long)nanoseconds,
    (unsigned long long)checksum
  );
}

void *z_bench_malloc(size_t size) {
  atomic_fetch_add_explicit(&z_bench_allocation_count, 1, memory_order_relaxed);
  atomic_fetch_add_explicit(&z_bench_requested_bytes, (uint64_t)size, memory_order_relaxed);
  return malloc(size);
}

void *z_bench_calloc(size_t count, size_t size) {
  atomic_fetch_add_explicit(&z_bench_allocation_count, 1, memory_order_relaxed);
  atomic_fetch_add_explicit(&z_bench_requested_bytes, (uint64_t)(count * size), memory_order_relaxed);
  return calloc(count, size);
}

void *z_bench_realloc(void *storage, size_t size) {
  atomic_fetch_add_explicit(&z_bench_allocation_count, 1, memory_order_relaxed);
  atomic_fetch_add_explicit(&z_bench_requested_bytes, (uint64_t)size, memory_order_relaxed);
  return realloc(storage, size);
}

void z_bench_free(void *storage) {
  if (storage != NULL) atomic_fetch_add_explicit(&z_bench_free_count, 1, memory_order_relaxed);
  free(storage);
}
