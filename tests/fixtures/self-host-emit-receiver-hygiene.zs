import console from "std/console";

struct Counter {
  total: i32;

  function add(inout this, self: i32): i32 {
    this.total = this.total + self;
    return this.total;
  }

  function inspect(): i32 {
    const self = 2;
    return this.total + self;
  }

  function withBorrow(in self: i32): i32 {
    return this.total + self;
  }
}

struct Message {
  text: String;
  deinit { console.log(`released ${this.text}`); }

  function finish(move this, self: String): usize {
    return this.text.byteLength + self.byteLength;
  }
}

class Store {
  text: String;
  constructor(self: String) { this.text = move self; }
  deinit {
    const self = "store";
    console.log(`released ${self} ${this.text}`);
  }

  function append(inout this, self: String): usize {
    this.text = `${this.text}${self}`;
    return this.text.byteLength;
  }

  function inspect(): usize {
    const self = "local";
    const read = (): usize => self.byteLength;
    return this.text.byteLength + read();
  }
}

function identity<T>(self: T): T { return self; }
function rawIdentity(self: i32): i32 = raw c { return self; }

function main(): i32 {
  let counter = Counter({ total: 0 });
  if (counter.add(5) != 5) return 1;
  if (counter.inspect() != 7) return 2;
  const increment = 3;
  if (counter.withBorrow(in increment) != 8) return 3;
  const message = Message({ text: "owner" });
  if (message.finish("argument") != 13) return 4;
  let store = new Store("first");
  if (store.append("second") != 11) return 5;
  if (store.inspect() != 16) return 6;
  if (identity(42) != 42) return 7;
  const self = rawIdentity(19);
  const z_self = 23;
  const observed = rawIdentity(self);
  if (observed + z_self != 42) return 8;
  const found = Option<i32>.some(42);
  match (found) { some(self) => { if (self != 42) return 9; } none => return 10; }
  console.log("receiver bindings passed");
  return 0;
}
