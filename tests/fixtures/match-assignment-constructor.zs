import console from "std/console";

struct Receipt {
  label: String;
  deinit { console.log(this.label); }
}

class Owner {
  receipt: Receipt;
  constructor(option: Option<String>) {
    this.receipt = match (option) {
      some(text) => Receipt({ label: text });
      none => Receipt({ label: "fallback" });
    };
    this.receipt = Receipt({ label: "replacement" });
  }
}

function main(): i32 {
  const text = "initial";
  const first = new Owner(Option<String>.some(text.copyBytes(0, text.byteLength)));
  const second = new Owner(Option<String>.none);
  if (first.receipt.label != "replacement" || second.receipt.label != "replacement") return 1;
  return 0;
}
