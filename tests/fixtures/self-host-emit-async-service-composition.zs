struct Message {
  body: String;
}

enum Outcome {
  success String,
  failure String,
}

readonly class Service {
  readonly prefix: String;

  async function invoke(in message: Message): String {
    return `${this.prefix}:${message.body}`;
  }
}

async function dispatchMessage(
  message: Message,
  service: Service
): String {
  return `${service.prefix}:${message.body}`;
}

function decode(in source: String): Message throws String {
  if (source == "bad") throw "decode";
  return Message({ body: copy source });
}

async function route(
  in source: String,
  service: Service
): String {
  const decoded = attempt decode(in source);
  match (decoded) {
    failure(error) => return copy error;
    success(message) => return await dispatchMessage(
      move message,
      service
    );
  }
}

async function dispatch(
  in source: String,
  service: Service
): String {
  const loaded = await route(in source, service);
  const outcome = Outcome.success(move loaded);
  return match (outcome) {
    success(value) => move value;
    failure(error) => move error;
  };
}

async function main(): i32 {
  const service = new Service({ prefix: "native" });
  const request = "request";
  const first = await dispatch(in request, service);
  if (first != "native:request") return 1;
  const bad = "bad";
  const second = await dispatch(in bad, service);
  return second == "decode" ? 0 : 2;
}
