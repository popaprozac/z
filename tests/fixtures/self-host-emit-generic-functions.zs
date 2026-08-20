struct GenericFunctionError {
  code: i32;
}

struct Pair<T> {
  first: T;
  second: T;
}

function identity<T>(value: T): T {
  return value;
}

function forward<T>(value: T): T {
  return identity(value);
}

function first<T>(pair: Pair<T>): T {
  return pair.first;
}

function require<T>(value: T, fail: boolean): T throws GenericFunctionError {
  if (fail) throw GenericFunctionError({ code: 7 });
  return value;
}

function main(): i32 {
  const inferred = forward(20);
  const explicit = identity<i32>(22);
  const pair = Pair({ first: 42, second: 0 });
  const selected = first(pair);
  const required = attempt require<String>("owned", false);
  const status = match (required) {
    success(value) => {
      if (value != "owned") return 1;
      select 0;
    }
    failure(error) => error.code;
  };
  return inferred + explicit + selected - 84 + status;
}
