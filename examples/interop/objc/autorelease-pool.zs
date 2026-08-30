import objc from "std/objc";

struct PoolError {
  code: i32;
}

function pooledValue(shouldFail: boolean): String throws PoolError {
  return try objc.pool((): String throws PoolError => {
    if (shouldFail) throw PoolError({ code: 7 });
    return "drained safely";
  });
}

function main(): i32 {
  const value = attempt pooledValue(false);
  const failure = attempt pooledValue(true);
  const valueStatus = match (value) {
    success(text) => text.byteLength == 14 ? 0 : 1;
    failure(_) => 2;
  };
  const failureStatus = match (failure) {
    success(_) => 3;
    failure(error) => error.code == 7 ? 0 : 4;
  };
  return valueStatus + failureStatus;
}
