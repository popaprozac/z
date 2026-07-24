#include "../../support/bench.h"

#include <stdint.h>
#include <stdlib.h>

typedef struct {
  uint64_t *data;
  uintptr_t length;
  uintptr_t capacity;
} Values;

static void values_push(Values *self, uint64_t value) {
  if (self->length == self->capacity) {
    uintptr_t next = self->capacity == 0 ? 4 : self->capacity * 2;
    if (next > SIZE_MAX / sizeof(uint64_t)) abort();
    void *storage = realloc(self->data, next * sizeof(uint64_t));
    if (storage == NULL) abort();
    self->data = storage;
    self->capacity = next;
  }
  self->data[self->length] = value;
  self->length += 1;
}

int main(void) {
  const uint64_t iterations = z_bench_iterations();
  Values values = {0};
  uint64_t index = 0;
  const uint64_t started = z_bench_now_ns();

  while (index < iterations) {
    values_push(&values, index);
    index += 1;
  }

  uint64_t checksum = 0;
  uintptr_t read = 0;
  while (read < values.length) {
    if (read >= values.length) abort();
    checksum += values.data[read];
    read += 1;
  }

  z_bench_report("dynamic-array", z_bench_now_ns() - started, checksum);
  free(values.data);
  return 0;
}
