import Foundation from "Foundation/Foundation.h";
import console from "std/console";

function nativeLength(in text: Foundation.NSString): i32 = raw objc {
  return (int32_t)text.length;
}

function readCount(in value: i32): i32 = raw c {
  return *value;
}

function increment(inout value: i32): void = raw c {
  *value += 1;
}

struct Resource {
  text: Foundation.NSString;
  count: i32;

  deinit {
    console.log(`released ${nativeLength(in this.text)}`);
  }
}

struct Envelope {
  resource: Resource;
}

struct BorrowError { code: i32; }

function acquire(present: boolean, fail: boolean): Option<Envelope> throws BorrowError {
  if (fail) throw BorrowError({ code: 7 });
  if (!present) return Option<Envelope>.none;
  return Option.some(Envelope({ resource: Resource({ text: "okay", count: 42 }) }));
}

function inspect(in envelope: Envelope): i32 {
  return nativeLength(in envelope.resource.text);
}

function main(): i32 {
  let resource = Resource({ text: "okay", count: 41 });
  if (nativeLength(in resource.text) != 4) return 1;
  increment(inout resource.count);
  if (readCount(in resource.count) != 42) return 2;
  const envelope = Envelope({ resource: move resource });
  if (inspect(in envelope) != 4) return 3;
  const received = match (attempt acquire(true, false)) {
    success(value) => move value;
    failure(_) => return 4;
  };
  match (received) {
    some(value) => { if (inspect(in value) != 4) return 5; }
    none => return 6;
  }
  match (attempt acquire(false, false)) {
    success(value) => match (value) {
      some(_) => return 7;
      none => {}
    }
    failure(_) => return 8;
  }
  match (attempt acquire(false, true)) {
    success(_) => return 9;
    failure(error) => { if (error.code != 7) return 10; }
  }
  return 0;
}
