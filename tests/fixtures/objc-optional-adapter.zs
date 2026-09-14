import native from "AppKit/AppKit.h";
import objc from "std/objc";
import console from "std/console";
import { thread } from "std/thread";

class Observer on thread.main implements native.NSWindowDelegate {
  deinit { console.log("released optional adapter"); }
}

class Owner on thread.main {
  readonly adapter: Option<objc.Adapter<native.NSWindowDelegate>>;
}

function inspect(in owner: Owner): i32 on thread.main {
  return match (in owner.adapter) {
    some(adapter) => {
      const values = native.NSArray.arrayWithObject(adapter);
      select i32(values.count);
    }
    none => 0;
  };
}

function main(): i32 on thread.main {
  const empty = new Owner({ adapter: Option.none });
  if (inspect(in empty) != 0) return 1;
  const observer = new Observer({});
  const adapter = objc.adapt<native.NSWindowDelegate>(observer);
  const present = new Owner({ adapter: Option.some(adapter) });
  return inspect(in present) == 1 ? 0 : 2;
}
