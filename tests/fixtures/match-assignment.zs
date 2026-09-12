import console from "std/console";

struct Receipt {
  label: String;
  deinit { console.log(this.label); }
}

struct Failure { message: String; }

class Probe {
  registered: boolean;
  receipt: Receipt;
  constructor() {
    this.registered = false;
    this.receipt = Receipt({ label: "old field" });
  }
}

function reject(): Receipt throws Failure {
  throw Failure({ message: "rejected" });
}

function update(probe: Probe, option: Option<String>): void throws Failure {
  probe.receipt = match (option) {
    some(text) => {
      const arm = Receipt({ label: "failed arm" });
      if (text == "early") return;
      select try reject();
    }
    none => Receipt({ label: "new field" });
  };
}

function selectedIndex(): usize {
  console.log("index");
  return 0;
}

function main(): i32 {
  const probe = new Probe();
  const callback: (in options: Option<boolean>) => void = move (in options: Option<boolean>): void => {
    probe.registered = match (in options) {
      some(value) => value;
      none => false;
    };
  };
  const enabled = Option<boolean>.some(true);
  callback(in enabled);
  if (!probe.registered) return 1;
  const disabled = Option<boolean>.none;
  callback(in disabled);
  if (probe.registered) return 2;

  let number = 0;
  number = match (in enabled) { some(value) => value ? 42 : 1; none => -1; };
  if (number != 42) return 3;
  let values = Array<i32>(0);
  values[selectedIndex()] = match (in enabled) {
    some(value) => {
      const arm = Receipt({ label: "index arm" });
      console.log("value");
      select value ? 42 : 1;
    }
    none => -1;
  };
  if (values[0] != 42) return 4;

  let receipt = Receipt({ label: "old local" });
  receipt = match (in enabled) {
    some(_) => Receipt({ label: "new local" });
    none => Receipt({ label: "unused" });
  };
  const early = attempt update(probe, Option<String>.some("early"));
  match (early) { success => {} failure(_) => return 5; }
  if (probe.receipt.label != "old field") return 6;
  const failed = attempt update(probe, Option<String>.some("fail"));
  match (failed) { success => return 7; failure(error) => console.log(error.message); }
  if (probe.receipt.label != "old field") return 8;
  const updated = attempt update(probe, Option<String>.none);
  match (updated) { success => {} failure(_) => return 9; }
  return 0;
}
