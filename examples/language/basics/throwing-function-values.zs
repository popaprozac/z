import console from "std/console";

struct ResponseError {
  status: i32;
}

type ResponseValidator = (status: i32) => i32 throws ResponseError;

function requireSuccess(status: i32): i32 throws ResponseError {
  if (status < 200 || status >= 300) {
    throw ResponseError({ status });
  }
  return status;
}

function validate(
  in operation: ResponseValidator,
  status: i32
): i32 throws ResponseError {
  return try operation(status);
}

function main(): i32 {
  const standard: ResponseValidator = requireSuccess;
  const accepted = attempt validate(standard, 204);

  const minimum = 200;
  const strict: ResponseValidator = move (status) => {
    if (status < minimum || status >= 300) {
      throw ResponseError({ status });
    }
    return status;
  };
  const rejected = attempt strict(503);

  const acceptedStatus = match (accepted) {
    success(status) => status;
    failure(error) => error.status;
  };
  const rejectedStatus = match (rejected) {
    success(status) => status;
    failure(error) => error.status;
  };

  console.log(`accepted=${acceptedStatus} rejected=${rejectedStatus}`);
  return 0;
}
