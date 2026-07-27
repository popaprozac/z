struct Problem {
  code: i32;

  deinit {}
}

struct Resource {
  id: i32;

  deinit {}
}

function load(shouldFail: boolean): i32 throws Problem {
  if (shouldFail) {
    throw Problem({ code: 7 });
  }
  return 42;
}

function relay(shouldFail: boolean): i32 throws Problem {
  const audit: Resource = Resource({ id: 0 });
  return try load(shouldFail);
}

function adjusted(shouldFail: boolean): i32 throws Problem {
  const audit: Resource = Resource({ id: 1 });
  const value = try load(shouldFail);
  return value;
}

function inspect(shouldFail: boolean): i32 {
  const result = attempt relay(shouldFail);
  return match (result) {
    success(value) => value;
    failure(error) => -error.code;
  };
}

function inspectAdjusted(shouldFail: boolean): i32 {
  const result = attempt adjusted(shouldFail);
  return match (result) {
    success(value) => value;
    failure(error) => -error.code;
  };
}

function discardErrorResult(): i32 {
  const result = attempt load(false);
  return 0;
}

function validate(shouldFail: boolean): void throws Problem {
  if (shouldFail) {
    throw Problem({ code: 7 });
  }
  return;
}

function relayVoid(shouldFail: boolean): void throws Problem {
  const audit: Resource = Resource({ id: 2 });
  try validate(shouldFail);
  return;
}

function inspectVoid(shouldFail: boolean): i32 {
  const result = attempt relayVoid(shouldFail);
  return match (result) {
    success => 42;
    failure(error) => -error.code;
  };
}

function discardVoidResult(): i32 {
  const result = attempt validate(false);
  return 0;
}

function loadResource(shouldFail: boolean): Resource throws Problem {
  if (shouldFail) {
    throw Problem({ code: 7 });
  }
  return Resource({ id: 42 });
}

function inspectResource(shouldFail: boolean): i32 {
  const result = attempt loadResource(shouldFail);
  return match (result) {
    success(resource) => resource.id;
    failure(error) => -error.code;
  };
}

function discardResult(): i32 {
  const result = attempt loadResource(false);
  return 0;
}

function main(): i32 {
  return inspect(false)
    + inspect(true)
    + 7
    + inspectAdjusted(false)
    + inspectAdjusted(true)
    - 35
    + inspectVoid(false)
    - 42
    + inspectVoid(true)
    + 7
    + discardVoidResult()
    + inspectResource(false)
    - 42
    + inspectResource(true)
    + 7
    + discardErrorResult()
    + discardResult();
}
