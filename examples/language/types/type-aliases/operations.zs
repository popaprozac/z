export type Operation = (left: i32, right: i32) => i32;

export function add(left: i32, right: i32): i32 {
  return left + right;
}

export function apply(operation: Operation, left: i32, right: i32): i32 {
  return operation(left, right);
}
