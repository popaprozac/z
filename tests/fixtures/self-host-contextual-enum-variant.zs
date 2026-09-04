enum CommandState {
  off,
  on,
  mixed,
}

function value(state: CommandState): i32 {
  return match (state) {
    off => 0;
    on => 1;
    mixed => -1;
  };
}

function main(): i32 {
  return value(CommandState.on) - 1;
}
