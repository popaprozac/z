struct LifecycleError {
  code: i32;
}

trait Lifecycle {
  function start(value: i32): i32 throws LifecycleError;
}

struct Service implements Lifecycle {
  offset: i32;

  function start(value: i32): i32 throws LifecycleError {
    if (value < 0) throw LifecycleError({ code: value });
    return this.offset + value;
  }
}

function start<T: Lifecycle>(in service: T, value: i32): i32
  throws LifecycleError {
  return try service.start(value);
}

function main(): i32 {
  const service = Service({ offset: 20 });
  const success = attempt start(in service, 22);
  match (success) {
    success(value) => if (value != 42) return 1;
    failure(_) => return 2;
  }
  const failure = attempt start(in service, -7);
  return match (failure) {
    success(_) => 3;
    failure(error) => error.code + 7;
  };
}
