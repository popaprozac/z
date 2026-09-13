import native from "./objc-blocks.h";
import console from "std/console";

class State {
  value: i32;
  deinit { console.log(`released=${this.value}`); }
}

function main(): i32 {
  const state = new State({ value: 0 });
  native.ZObjCBlockFixture.invoke(move (outer): void => {
    console.log(`outer=${outer}`);
    const label = "nested";
    native.ZObjCBlockFixture.invoke(move (inner): void => {
      state.value = inner;
      console.log(`${label}=${state.value}`);
    });
  });
  return state.value - 42;
}
