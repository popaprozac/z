import console from "std/console";
import { delay } from "std/time";

// A reusable async closure lends its owned captures to each call: the
// environment keeps them, so a captured `String` is still there for the next
// call. A by-value parameter belongs to the call that received it, and an
// `in` parameter is lent through to the block.

struct Request {
  id: i32;
  label: String;
}

class Tally {
  count: i32;
}

type Handler = async (in request: Request) => i32;
type Namer = async (name: String) => usize;
type Collector = async (value: i32) => usize;
type Reporter = async () => void;

function makeHandler(prefix: String): Handler {
  return async move (in request: Request): i32 => {
    await delay(1);
    console.log(`${prefix} ${request.label} ${request.id}`);
    return request.id * 2;
  };
}

function makeNamer(): Namer {
  let seen: usize = 0;
  return async move (name: String): usize => {
    await delay(1);
    seen = seen + name.byteLength;
    console.log(`named ${name} ${seen}`);
    return seen;
  };
}

// A captured `let` collection grows in place from one call to the next.
function makeCollector(): Collector {
  let items = Array<i32>();
  return async move (value: i32): usize => {
    await delay(1);
    items.push(value);
    return items.length;
  };
}

function makeTallier(tally: Tally): Reporter {
  return async move (): void => {
    await delay(1);
    tally.count = tally.count + 1;
  };
}

async function show(in label: String, value: i32): void {
  await delay(1);
  console.log(`${label} ${value}`);
}

// An expression-bodied closure lends a capture to the call it awaits.
function makeShower(label: String, value: i32): Reporter {
  return async move (): void => await show(in label, value);
}

async function main(): i32 {
  const handler = makeHandler("handled");
  const request = Request({ id: 21, label: "first" });
  const once = await handler(in request);
  const twice = await handler(in request);
  console.log(`handler ${once} ${twice}`);
  const namer = makeNamer();
  const short = await namer("ab");
  const longer = await namer(`abc${1}`);
  console.log(`namer ${short} ${longer}`);
  const collector = makeCollector();
  const one = await collector(7);
  const two = await collector(8);
  console.log(`collector ${one} ${two}`);
  const tally = new Tally({ count: 0 });
  const bump = makeTallier(tally);
  await bump();
  await bump();
  console.log(`tally ${tally.count}`);
  const shower = makeShower(`shown ${1}`, 2);
  await shower();
  await shower();
  return 0;
}
