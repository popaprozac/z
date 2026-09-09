import console from "std/console";

type Handler = (in early: boolean) => void;

function invokeTwice(in handler: Handler): void {
  const early = true;
  const normal = false;
  handler(in early);
  handler(in normal);
}

function main(): i32 {
  const prefix = "nested";
  const outer: Handler = move (in early: boolean): void => {
    const text = `${prefix} ${early}`;
    const inner: Handler = move (in early: boolean): void => {
      const snapshot = copy text;
      console.log(snapshot);
      if (early) return;
      const suffix = `${snapshot} done`;
      console.log(suffix);
    };
    invokeTwice(in inner);
    const plain: Handler = (in early: boolean): void => {
      const rendered = `${early}`;
      console.log(rendered);
    };
    invokeTwice(in plain);
  };
  invokeTwice(in outer);
  return 0;
}
