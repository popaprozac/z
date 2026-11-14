import { State } from "./state.zs";

// Exporting an alias of an imported enum keeps `State.variant` resolvable.
export type PublicState = State;

function current(): PublicState {
  return State.running;
}

function main(): i32 {
  return match (current()) {
    running => 0;
    _ => 1;
  };
}
