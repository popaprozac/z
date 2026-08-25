struct Request {
  payload: String;
}

type Operation = async (in request: Request) => String;

enum OperationOption {
  some Operation,
  none,
}

async function route(
  option: OperationOption,
  in request: Request
): String {
  const forwarded = Request({ payload: copy request.payload });
  match (option) {
    some(operation) => return await operation(in forwarded);
    none => return "missing";
  }
}

async function main(): i32 {
  const request = Request({ payload: "free matched child" });
  const operation: Operation = async (
    in value: Request
  ): String => copy value.payload;
  const found = await route(
    OperationOption.some(move operation),
    in request
  );
  if (found != "free matched child") return 1;
  const missing = await route(OperationOption.none, in request);
  return missing == "missing" ? 0 : 2;
}
