#include "../../support/bench.h"

#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  pthread_mutex_t mutex;
  pthread_cond_t readable;
  pthread_cond_t writable;
  bool occupied;
  uint64_t value;
} Channel;

static void channel_initialize(Channel *channel) {
  if (pthread_mutex_init(&channel->mutex, NULL) != 0
      || pthread_cond_init(&channel->readable, NULL) != 0
      || pthread_cond_init(&channel->writable, NULL) != 0) abort();
  channel->occupied = false;
  channel->value = 0;
}

static void channel_send(Channel *channel, uint64_t value) {
  if (pthread_mutex_lock(&channel->mutex) != 0) abort();
  while (channel->occupied) {
    if (pthread_cond_wait(&channel->writable, &channel->mutex) != 0) abort();
  }
  channel->value = value;
  channel->occupied = true;
  if (pthread_cond_signal(&channel->readable) != 0) abort();
  if (pthread_mutex_unlock(&channel->mutex) != 0) abort();
}

static uint64_t channel_receive(Channel *channel) {
  if (pthread_mutex_lock(&channel->mutex) != 0) abort();
  while (!channel->occupied) {
    if (pthread_cond_wait(&channel->readable, &channel->mutex) != 0) abort();
  }
  const uint64_t value = channel->value;
  channel->occupied = false;
  if (pthread_cond_signal(&channel->writable) != 0) abort();
  if (pthread_mutex_unlock(&channel->mutex) != 0) abort();
  return value;
}

static void channel_destroy(Channel *channel) {
  if (pthread_cond_destroy(&channel->readable) != 0
      || pthread_cond_destroy(&channel->writable) != 0
      || pthread_mutex_destroy(&channel->mutex) != 0) abort();
}

int main(void) {
  const uint64_t iterations = z_bench_iterations();
  Channel channel;
  channel_initialize(&channel);
  uint64_t index = 0;
  uint64_t checksum = 0;
  const uint64_t started = z_bench_now_ns();

  while (index < iterations) {
    channel_send(&channel, index);
    checksum += channel_receive(&channel);
    index += 1;
  }

  const uint64_t elapsed = z_bench_now_ns() - started;
  channel_destroy(&channel);
  z_bench_report("channel-local", elapsed, checksum);
  return 0;
}
