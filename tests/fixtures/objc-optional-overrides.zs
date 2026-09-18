import native from "objc-optional-overrides.h";
import { thread } from "std/thread";

class Destination extends native.ZCallbackDestination on thread.main {
  constructor() { super.init(); }

  override function accept(in info: native.ZDropInfo): i32 as "acceptInfo:" {
    const value = info.value;
    const caption = info.caption;
    const position = info.position;
    if (caption.length != 5 || position.x != 3 || position.y != 4) return -1;
    return value + 7;
  }

  override function inherited(): i32 as "inheritedValue" {
    return super.inheritedValue() + 1;
  }

  override function optionalValue(): i32 as "optionalValue" {
    return 42;
  }
}

function main(): i32 on thread.main {
  native.z_callback_prepare();
  const target = new Destination();
  if (native.z_callback_dispatch(target) != 42) return 1;
  if (target.optionalValue() != 42) return 2;
  if (target.inherited() != 8) return 3;
  return 0;
}
