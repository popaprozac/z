struct Request {
  payload: String;
}

type Operation = async (in request: Request) => String;

readonly class Relay {
  readonly name: String;

  async function invoke(
    operation: Operation,
    in request: Request,
    enabled: boolean
  ): String {
    let separator: usize = 0;
    while (
      separator < request.payload.byteLength
      && request.payload.byteAt(separator) != 46
    ) {
      separator = separator + 1;
    }
    if (!enabled || separator == 0) {
      return "disabled";
    }
    return await operation(in request);
  }
}

async function main(): i32 {
  const relay = new Relay({ name: "notes" });
  const request = Request({ payload: "notes.branch child" });
  const skippedOperation: Operation = async (
    in value: Request
  ): String => copy value.payload;
  const skipped = await relay.invoke(
    move skippedOperation,
    in request,
    false
  );
  if (skipped != "disabled") return 1;
  const operation: Operation = async (
    in value: Request
  ): String => copy value.payload;
  const result = await relay.invoke(move operation, in request, true);
  return result == "notes.branch child" ? 0 : 2;
}
