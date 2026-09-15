import bench from "./input.h";

export struct State {
  values: Array<u64>;
  indices: Array<usize>;
  code: Array<u64>;
  registers: Array<u64>;
}

export function makeState(width: usize): State {
  let state = State({ values: Array<u64>(), indices: Array<usize>(),
    code: Array<u64>(), registers: Array<u64>() });
  let index: usize = 0;
  while (index < width) {
    const mixed = bench.z_bench_mix(u64(index));
    state.values.push(mixed);
    state.indices.push(usize(mixed % u64(width)));
    state.code.push(mixed);
    index = index.wrappingAdd(1);
  }
  index = 0;
  while (index < 256) {
    state.registers.push(u64(index));
    index = index.wrappingAdd(1);
  }
  return state;
}

export function linear(in state: State, rounds: u64): u64 {
  let checksum: u64 = 0;
  let round: u64 = 0;
  while (round < rounds) {
    let index: usize = 0;
    while (index < state.values.length) {
      checksum = checksum.wrappingMultiply(33).wrappingAdd(state.values[index]);
      index = index.wrappingAdd(1);
    }
    round = round.wrappingAdd(1);
  }
  return checksum;
}

export function indirect(in state: State, rounds: u64): u64 {
  let checksum: u64 = 0;
  let round: u64 = 0;
  while (round < rounds) {
    let index: usize = 0;
    while (index < state.indices.length) {
      const address = state.indices[index];
      checksum = checksum.wrappingMultiply(33).wrappingAdd(state.values[address]);
      index = index.wrappingAdd(1);
    }
    round = round.wrappingAdd(1);
  }
  return checksum;
}

export function registersDirect(inout state: State, rounds: u64): u64 {
  let checksum: u64 = 0;
  let round: u64 = 0;
  while (round < rounds) {
    let ip: usize = 0;
    while (ip < state.code.length) {
      const instruction = state.code[ip];
      const destination = usize(instruction & 255);
      const source = usize((instruction >> 8) & 255);
      const value = state.registers[source].wrappingAdd(instruction >> 16);
      state.registers[destination] = value;
      checksum = checksum.wrappingAdd(value);
      ip = ip.wrappingAdd(1);
    }
    round = round.wrappingAdd(1);
  }
  return checksum;
}

export function registersView(inout state: State, rounds: u64): u64 {
  const program = view state.code;
  let checksum: u64 = 0;
  let round: u64 = 0;
  while (round < rounds) {
    let ip: usize = 0;
    while (ip < program.length) {
      const instruction = program[ip];
      const destination = usize(instruction & 255);
      const source = usize((instruction >> 8) & 255);
      const value = state.registers[source].wrappingAdd(instruction >> 16);
      state.registers[destination] = value;
      checksum = checksum.wrappingAdd(value);
      ip = ip.wrappingAdd(1);
    }
    round = round.wrappingAdd(1);
  }
  return checksum;
}
