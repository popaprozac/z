function action(value: i32): i32 { return value; }
function invoke(in action: () => i32): i32 { return action(); }
function capture(action: () => i32): () => i32 {
  return move (): i32 => invoke(action);
}
function main(): i32 {
  const action: () => i32 = (): i32 => 42;
  const callback = capture(action);
  return callback() - 42;
}
