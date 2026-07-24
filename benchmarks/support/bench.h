#ifndef Z_BENCH_SUPPORT_H
#define Z_BENCH_SUPPORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint64_t z_bench_iterations(void);
uint64_t z_bench_now_ns(void);
uint64_t z_bench_mix(uint64_t value);
void z_bench_drop(uint64_t value);
void z_bench_consume_u64(uint64_t value);
void z_bench_report(const char *name, uint64_t nanoseconds, uint64_t checksum);

void *z_bench_malloc(size_t size);
void *z_bench_calloc(size_t count, size_t size);
void *z_bench_realloc(void *storage, size_t size);
void z_bench_free(void *storage);

#ifdef __cplusplus
}
#endif

#endif
