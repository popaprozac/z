export struct NativeFailure {
  code: i32;
  message: String;
}

export struct Worker {
  function perform(): i32 throws NativeFailure {
    throw NativeFailure({ code: 9, message: "worker failure" });
  }
}

export function makeWorker(): Worker {
  return Worker();
}
