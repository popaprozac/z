import console from "std/console";
import Foundation from "Foundation/Foundation.h";
import Native from "objc-blocks.h";

class EventState {
  value: i32;

  deinit {
    console.log(`released event state ${this.value}`);
  }
}

function main(): i32 {
  let state = new EventState({ value: 0 });
  Native.ZObjCBlockFixture.invoke(move (value) => {
    state.value = value;
    console.log(`event value=${state.value}`);
  });
  return 0;
}
