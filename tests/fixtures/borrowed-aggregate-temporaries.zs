import console from "std/console";

struct Options {
  title: String = "";
  tags: Array<String> = Array<String>();

  deinit {
    console.log(`released ${this.title}`);
  }
}

struct Measurer {
  base: usize;

  function measure(in options: Options): usize {
    return this.base + options.title.byteLength + options.tags.length;
  }
}

class Holder {
  readonly size: usize;

  constructor(in options: Options) {
    this.size = options.title.byteLength;
  }
}

class Label {
  readonly size: usize;

  constructor(in text: String) {
    this.size = text.byteLength;
  }
}

enum Failure { rejected }

function measure(in options: Options): usize {
  return options.title.byteLength + options.tags.length;
}

function check(in options: Options): usize throws Failure {
  if (options.title == "bad") throw Failure.rejected;
  return options.title.byteLength;
}

function note(value: i32): i32 {
  console.log(`evaluated ${value}`);
  return value;
}

function size(in text: String): usize {
  return text.byteLength;
}

function pick(flag: boolean): usize {
  return flag ? measure(Options({ title: "then" })) : measure(Options({ title: "else!" }));
}

function pickText(flag: boolean): usize {
  return flag ? size(`then ${note(1)}`) : size(`else ${note(2)}`);
}

function early(): usize {
  return measure(Options({ title: `ret${1}` }));
}

function main(): i32 {
  const first = measure(Options({ title: "call", tags: Array<String>("a", "b") }));
  console.log(`call ${first}`);
  const measurer = Measurer({ base: 10 });
  const method = measurer.measure(Options({ title: `m${first}` }));
  console.log(`method ${method}`);
  const holder = new Holder(Options({ title: "ctor" }));
  console.log(`ctor ${holder.size}`);
  const label = new Label(`label ${first}`);
  console.log(`label ${label.size}`);
  measure(Options({ title: "discarded" }));
  if (measure(Options({ title: "cond" })) != 4) return 1;
  const skip = false;
  if (skip && measure(Options({ title: "skipped" })) > 0) return 1;
  let count: usize = 0;
  while (measure(Options({ title: "loop" })) > count) {
    count = count + 2;
  }
  console.log(`count ${count}`);
  const picked = pick(false);
  console.log(`pick ${picked}`);
  const pickedText = pickText(false);
  console.log(`pick text ${pickedText}`);
  const returned = early();
  console.log(`early ${returned}`);
  const good = attempt check(Options({ title: "good" }));
  const bad = attempt check(Options({ title: "bad" }));
  match (good) {
    success(value) => console.log(`good ${value}`);
    failure(_) => console.log("good failed");
  }
  match (bad) {
    success(_) => console.log("bad passed");
    failure(_) => console.log("bad rejected");
  }
  return 0;
}
