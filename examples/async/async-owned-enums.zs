import console from "std/console";

class Session {
  id: i32;

  deinit {
    console.log(`released enum session ${this.id}`);
  }
}

struct Resource {
  id: i32;

  deinit {
    console.log(`released enum resource ${this.id}`);
  }
}

async function optionalSession(id: i32): Option<Session> {
  return Option.some(new Session({ id }));
}

async function relayOption(option: Option<Session>): Option<Session> {
  return option;
}

async function loadSession(id: i32): Session throws i32 {
  return new Session({ id });
}

async function failSession(): Session throws i32 {
  throw 7;
}

async function loadResource(id: i32): Resource throws i32 {
  return Resource({ id });
}

async function loadOptional(id: i32): Option<Session> throws i32 {
  return Option.some(new Session({ id }));
}

async function main(): i32 {
  const optional = await optionalSession(41);
  const relayed = await relayOption(optional);
  const empty: Option<Session> = Option.none;
  const outcome = attempt await loadSession(42);
  const failed = attempt await failSession();
  const resourceOutcome = attempt await loadResource(43);
  const nestedOutcome = attempt await loadOptional(44);
  return 0;
}
