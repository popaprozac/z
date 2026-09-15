#include "input.h"
#include <stdlib.h>

// BENCH_REMOVE_BOUNDS is an experiment on known-valid benchmark inputs only.
// It is not the semantics of the checked C reference or of release-mode Z.
static uintptr_t at(uintptr_t index, uintptr_t length) {
#ifndef BENCH_REMOVE_BOUNDS
  if (index >= length) abort();
#else
  (void)length;
#endif
  return index;
}

typedef struct { uint64_t *data; uintptr_t length, capacity; } Values;
typedef struct { uintptr_t *data; uintptr_t length, capacity; } Indices;
typedef struct { Values values; Indices indices; Values code, registers; } State;

#ifdef BENCH_ISOLATE
__attribute__((noinline)) uint64_t kernel(State *state, uint64_t rounds) {
#else
static uint64_t kernel(State *state, uint64_t rounds) {
#endif
  uint64_t checksum = 0;
  const Values *program = &state->code;
  (void)program;
  for (uint64_t round = 0; round < rounds; ++round) {
#if BENCH_CASE == 0
    for (uintptr_t i = 0; i < state->values.length; ++i) {
#elif BENCH_CASE == 1
    for (uintptr_t i = 0; i < state->indices.length; ++i) {
#else
    for (uintptr_t i = 0; i < state->code.length; ++i) {
#endif
#if BENCH_CASE == 0
      checksum = checksum * 33 + state->values.data[at(i, state->values.length)];
#elif BENCH_CASE == 1
      const uintptr_t address = state->indices.data[at(i, state->indices.length)];
      checksum = checksum * 33 + state->values.data[at(address, state->values.length)];
#else
#if BENCH_CASE == 3
      const uint64_t instruction = program->data[at(i, program->length)];
#else
      const uint64_t instruction = state->code.data[at(i, state->code.length)];
#endif
      const uintptr_t destination = instruction & 255;
      const uintptr_t source = (instruction >> 8) & 255;
      const uint64_t value = state->registers.data[at(source, state->registers.length)] + (instruction >> 16);
      state->registers.data[at(destination, state->registers.length)] = value;
      checksum += value;
#endif
    }
  }
  return checksum;
}

int main(void) {
  const uint64_t rounds = z_bench_iterations();
  const uintptr_t width = z_index_bench_width();
  State state = {
    .values = { malloc(width * sizeof(uint64_t)), width, width },
    .indices = { malloc(width * sizeof(uintptr_t)), width, width },
    .code = { malloc(width * sizeof(uint64_t)), width, width },
    .registers = { malloc(256 * sizeof(uint64_t)), 256, 256 },
  };
  if (!state.values.data || !state.indices.data || !state.code.data || !state.registers.data) abort();
  for (uintptr_t i = 0; i < width; ++i) {
    const uint64_t mixed = z_bench_mix(i);
    state.values.data[i] = mixed;
    state.indices.data[i] = mixed % width;
    state.code.data[i] = mixed;
  }
  for (uintptr_t i = 0; i < 256; ++i) state.registers.data[i] = i;
  const uint64_t started = z_bench_now_ns();
  const uint64_t checksum = kernel(&state, rounds);
  z_bench_report(BENCH_NAME, z_bench_now_ns() - started, checksum);
  free(state.registers.data);
  free(state.code.data);
  free(state.indices.data);
  free(state.values.data);
  return 0;
}
