type Operation = (value: i32) => i32;

export readonly class Calculator {
  function apply(operation: Operation, value: i32): i32 {
    return operation(value);
  }
}

export function double(value: i32): i32 { return value * 2; }
