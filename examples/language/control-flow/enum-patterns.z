struct Response {
  status: i32;
  body: String;
}

enum ResponseState {
  ready Response,
  empty,
}

function inspect(in state: ResponseState): i32 {
  return match (state) {
    ready({ status }) => status;
    empty => 0;
  };
}

function main(): i32 {
  const borrowed = ResponseState.ready({ status: 200, body: "ok" });
  const observed = inspect(borrowed);

  const owned = ResponseState.ready({ status: 201, body: "created" });
  const consumed = match (owned) {
    ready({ status: code, body }) => code;
    empty => 0;
  };

  if (observed == 200 && consumed == 201) {
    return 0;
  }
  return 1;
}
