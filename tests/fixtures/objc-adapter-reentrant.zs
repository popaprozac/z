import native from "objc-adapter-reentrant.h";
import objc from "std/objc";
import { thread } from "std/thread";

class Handler on thread.main implements native.ZReentrantHandler {
  readonly expected: i32;
  readonly result: i32;
  function receive(in owner: native.ZReentrantOwner): void as "receive:" {
    const expected = this.expected;
    owner.clear();
    native.z_reentrant_expect(expected);
  }
  function value(in owner: native.ZReentrantOwner): i32 as "value:" {
    const expected = this.expected;
    owner.clear();
    native.z_reentrant_expect(expected);
    return this.result;
  }
  deinit { native.z_reentrant_destroy(); }
}

function install(in owner: native.ZReentrantOwner, expected: i32): void on thread.main {
  const handler = new Handler({ expected, result: 42 });
  const adapter = objc.adapt<native.ZReentrantHandler>(handler);
  owner.handler = adapter;
}

function main(): i32 on thread.main {
  const owner = native.ZReentrantOwner.alloc().init();
  install(owner, 0);
  owner.fire();
  native.z_reentrant_expect(1);
  install(owner, 1);
  if (owner.read() != 42) return 1;
  native.z_reentrant_expect(2);
  return 0;
}
