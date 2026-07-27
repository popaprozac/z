import {
  Wrapper,
  makeWrapper,
} from "./model.zs";

function readValue(in wrapper: Wrapper): i32 {
  return match (in wrapper.item) {
    some(payload) => payload.value;
    none => 0;
  };
}

function main(): i32 {
  const wrapper = makeWrapper(42);
  return readValue(wrapper);
}
