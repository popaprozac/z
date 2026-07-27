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

function inspect(shouldFail: boolean): i32 {
  const result: Result<i32, Problem> = attempt load(shouldFail);
  return match (result) {
    success(value) => value;
    failure(error) => -error.code;
  };
}

function discardErrorResult(): i32 {
  const result: Result<i32, Problem> = attempt load(false);
  return 0;
}

function loadResource(shouldFail: boolean): Resource throws Problem {
  if (shouldFail) {
    throw Problem({ code: 7 });
  }
  return Resource({ id: 42 });
}

function inspectResource(shouldFail: boolean): i32 {
  const result: Result<Resource, Problem> = attempt loadResource(shouldFail);
  return match (result) {
    success(resource) => resource.id;
    failure(error) => -error.code;
  };
}

function discardResult(): i32 {
  const result: Result<Resource, Problem> = attempt loadResource(false);
  return 0;
}

function main(): i32 {
  return inspect(false)
    + inspect(true)
    + 7
    + inspectResource(false)
    - 42
    + inspectResource(true)
    + 7
    + discardErrorResult()
    + discardResult();
}
