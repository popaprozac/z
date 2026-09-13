import console from "std/console";

type Thunk = () => String;
struct Saved { callback: Thunk; }
type Factory = (payload: String) => Saved;
type Edit = (inout text: String) => void;

function increment(inout value: i32): i32 {
  value = value + 1;
  return value;
}

function main(): i32 {
  // The returned environment must own the invocation's String after it exits.
  const factory: Factory = (payload: String): Saved => {
    const callback: Thunk = move (): String => { return copy payload; };
    return Saved({ callback });
  };
  const words = "owned parameter";
  const input = copy words;
  const saved = factory(input);
  const message = saved.callback();
  console.log(message);

  // A non-escaping inner closure reborrows writable parameter storage.
  const edit: Edit = (inout text: String): void => {
    const update = (): void => { text = "updated parameter"; };
    update();
  };
  const original = "original";
  let text = copy original;
  edit(inout text);
  console.log(text);

  const outer = (value: String): void => {
    const inner = (value: i32): void => {
      const deepest = move (): void => { console.log(`${value}`); };
      deepest();
    };
    inner(42);
    console.log(value);
  };
  outer("outer parameter");
  const withExpression = (value: i32): i32 => {
    const read = (): i32 => value;
    return read();
  };
  if (withExpression(42) != 42) return 1;
  const withMutableExpression = (inout value: i32): i32 => {
    const change = (): i32 => increment(inout value);
    return change();
  };
  let count = 41;
  if (withMutableExpression(inout count) != 42 || count != 42) return 2;
  return 0;
}
