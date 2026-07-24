#include "../../support/bench.h"

#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  uint64_t input;
  uint64_t output;
} Worker;

static void *worker_main(void *raw) {
  Worker *worker = raw;
  worker->output = worker->input;
  return NULL;
}

int main(void) {
  const uint64_t iterations = z_bench_iterations();
  uint64_t index = 0;
  uint64_t checksum = 0;
  const uint64_t started = z_bench_now_ns();

  while (index < iterations) {
    Worker *worker = malloc(sizeof(Worker));
    if (worker == NULL) abort();
    worker->input = index;
    worker->output = 0;
    pthread_t thread;
    if (pthread_create(&thread, NULL, worker_main, worker) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
    checksum += worker->output;
    free(worker);
    index += 1;
  }

  z_bench_report("native-thread", z_bench_now_ns() - started, checksum);
  return 0;
}
