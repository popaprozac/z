import console from "std/console";
import { thread } from "std/thread";

struct Backend {
  handle: i32;
  function release(inout this): void {
    console.log(`${this.handle}`);
    this.handle = 0;
  }
  deinit on thread.any { console.log(`${this.handle}`); }
}

struct Owner {
  backend: Backend;
  deinit { this.backend.release(); }
}

struct TransferableOwner {
  backend: Backend;
  deinit on thread.any { this.backend.release(); }
}

class SharedOwner {
  backend: Backend;
  deinit { this.backend.release(); }
}

function exercise(): void {
  const owner = Owner({ backend: Backend({ handle: 1 }) });
  const transferable = TransferableOwner({ backend: Backend({ handle: 2 }) });
  const shared = new SharedOwner({ backend: Backend({ handle: 3 }) });
  const alias = shared;
}

function main(): i32 {
  exercise();
  console.log("done");
  return 0;
}
