import console from "std/console";

struct Payload {
  message: String;
  deinit { console.log(`released ${this.message}`); }
}

struct Envelope {
  payload: Payload;
}

function decode(fail: boolean): Payload throws Payload {
  if (fail) throw Payload({ message: "error" });
  return Payload({ message: "message" });
}

async function consume(payload: Payload): i32 {
  return 0;
}

async function route(fail: boolean): i32 {
  const decoded = attempt decode(fail);
  match (decoded) {
    success(payload) => return await consume(move payload);
    failure(error) => return 1;
  }
}

async function load(fail: boolean): Payload throws Payload {
  return try decode(fail);
}

async function wrap(fail: boolean): Envelope {
  const loaded = attempt await load(fail);
  match (loaded) {
    success(payload) => return Envelope({ payload: move payload });
    failure(error) => return Envelope({ payload: move error });
  }
}

async function main(): i32 {
  const accepted = await route(false);
  const rejected = await route(true);
  const good = await wrap(false);
  const bad = await wrap(true);
  return accepted + rejected - 1;
}
