export struct Protocol<Command, Message> {}

enum Command {
  start,
}

enum Message {
  complete,
}

type ApplicationProtocol = Protocol<Command, Message>;

export struct Registry {
  function get<CommandType, MessageType>(
    protocol: Protocol<CommandType, MessageType>
  ): i32 {
    return 42;
  }
}

function main(): i32 {
  const registry = Registry();
  return registry.get(ApplicationProtocol()) - 42;
}
