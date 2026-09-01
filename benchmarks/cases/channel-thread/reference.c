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
  uint64_t iterations;
  uint64_t checksum;
} Channel;

static void *consume(void *raw) {
  Channel *channel = raw;
  uint64_t received = 0;
  uint64_t checksum = 0;
  while (received < channel->iterations) {
    if (pthread_mutex_lock(&channel->mutex) != 0) abort();
    while (!channel->occupied) {
      if (pthread_cond_wait(&channel->readable, &channel->mutex) != 0) abort();
    }
    checksum += channel->value;
    channel->occupied = false;
    if (pthread_cond_signal(&channel->writable) != 0) abort();
    if (pthread_mutex_unlock(&channel->mutex) != 0) abort();
    received += 1;
  }
  channel->checksum = checksum;
  return NULL;
}

int main(void) {
  Channel channel = {
    .occupied = false,
    .value = 0,
    .iterations = z_bench_iterations(),
    .checksum = 0,
  };
  if (pthread_mutex_init(&channel.mutex, NULL) != 0
      || pthread_cond_init(&channel.readable, NULL) != 0
      || pthread_cond_init(&channel.writable, NULL) != 0) abort();

  pthread_t consumer;
  if (pthread_create(&consumer, NULL, consume, &channel) != 0) abort();
  uint64_t index = 0;
  const uint64_t started = z_bench_now_ns();
  while (index < channel.iterations) {
    if (pthread_mutex_lock(&channel.mutex) != 0) abort();
    while (channel.occupied) {
      if (pthread_cond_wait(&channel.writable, &channel.mutex) != 0) abort();
    }
    channel.value = index;
    channel.occupied = true;
    if (pthread_cond_signal(&channel.readable) != 0) abort();
    if (pthread_mutex_unlock(&channel.mutex) != 0) abort();
    index += 1;
  }
  if (pthread_join(consumer, NULL) != 0) abort();
  const uint64_t elapsed = z_bench_now_ns() - started;

  if (pthread_cond_destroy(&channel.readable) != 0
      || pthread_cond_destroy(&channel.writable) != 0
      || pthread_mutex_destroy(&channel.mutex) != 0) abort();
  z_bench_report("channel-thread", elapsed, channel.checksum);
  return 0;
}
