struct Request {
  payload: String;
}

type Operation = async (in request: Request) => String;
type SynchronousOperation = (in request: Request) => String;

enum OperationOption {
  some Operation,
  none,
}

readonly class Relay {
  readonly name: String;

  async function invoke(
    option: OperationOption,
    in request: Request
  ): String {
    match (option) {
      some(operation) => return await operation(in request);
      none => return "missing";
    }
  }
}

async function main(): i32 {
  const relay = new Relay({ name: "notes" });
  const request = Request({ payload: "matched child" });
  const synchronous: SynchronousOperation = (
    in value: Request
  ): String => copy value.payload;
  const synchronousResult = synchronous(in request);
  if (synchronousResult != "matched child") return 3;
  const operation: Operation = async (
    in value: Request
  ): String => copy value.payload;
  const found = await relay.invoke(
    OperationOption.some(move operation),
    in request
  );
  if (found != "matched child") return 1;
  const missing = await relay.invoke(
    OperationOption.none,
    in request
  );
  return missing == "missing" ? 0 : 2;
}
