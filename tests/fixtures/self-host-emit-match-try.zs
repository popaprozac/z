struct ReadError {
  code: i32;
}

function readValue(value: i32): i32 throws ReadError {
  if (value < 0) {
    throw ReadError({ code: 1 });
  }
  return value;
}

function forward(value: i32): i32 throws ReadError {
  const option = Option<i32>.some(value);
  return match (in option) {
    some(observed) => {
      select try readValue(observed);
    }
    none => 0;
  };
}

function main(): i32 {
  const result = attempt forward(42);
  return match (result) {
    success(value) => value;
    failure(error) => error.code;
  };
}
