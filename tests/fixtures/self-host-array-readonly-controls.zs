import { TextBuffer } from "std/text";

type Values = Array<i32>;

class State {
  count: i32;
  function increment(inout this): void { this.count = this.count + 1; }
}

class Owner {
  readonly state: State;
  values: Values;

  constructor(state: State) {
    this.state = state;
    this.values = Array<i32>();
  }

  function update(inout this): void {
    // A readonly reference does not prevent methods on its mutable identity.
    this.state.increment();
    this.values.push(20);
    this.values.clear();
    this.values.push(42);
  }
}

struct Editable { state: State; }
struct Entry { count: i32; }

function main(): i32 {
  let owner = new Owner(new State({ count: 0 }));
  owner.update();
  if (owner.state.count != 1 || owner.values[0] != 42) return 1;

  let editable = Editable({ state: new State({ count: 0 }) });
  editable.state.count = 2;
  if (editable.state.count != 2) return 2;
  let entries = Array<Entry>(Entry({ count: 0 }));
  entries[0].count = 3;
  if (entries[0].count != 3) return 3;

  let values: Values = Array<i32>();
  values.push(42);
  const frozen = values.freeze();
  if (frozen.length != 1 || frozen[0] != 42) return 4;

  // append is valid on TextBuffer, just not Array.
  let text = TextBuffer();
  text.append("ok");
  const message = text.finish();
  return message.byteLength == 2 ? 0 : 5;
}
