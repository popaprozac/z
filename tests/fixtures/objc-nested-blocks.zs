import native from "./objc-blocks.h";
import console from "std/console";

class State {
  value: i32;
  deinit { console.log(`released=${this.value}`); }
}

function main(): i32 {
  const state = new State({ value: 0 });
  const token = "token";
  const realm = "realm";
  native.ZObjCBlockFixture.invoke(move (outer): void => {
    console.log(`outer=${outer}`);
    const label = "nested";
    const tokenSnapshot = copy token;
    const realmSnapshot = copy realm;
    native.ZObjCBlockFixture.invoke(move (inner): void => {
      state.value = outer + inner;
      console.log(`${label}=${state.value}`);
      console.log(tokenSnapshot);
      console.log(realmSnapshot);
    });
  });
  return state.value - 84;
}
