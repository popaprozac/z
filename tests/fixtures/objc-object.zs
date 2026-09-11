import objc from "std/objc";
import native from "./objc-object.h";

function textLength(in value: objc.Object | null): i32 {
  if (value instanceof native.NSString) {
    const text: String = value;
    return i32(text.byteLength);
  }
  return 0;
}

function identity(in value: objc.Object): objc.Object {
  return value;
}

function main(): i32 {
  const value: objc.Object | null = native.ZObjectSource.text();
  if (value == null) return 1;
  native.ZObjectSource.accept(value);
  const retained: objc.Object = identity(value);
  if (native.ZObjectSource.same(retained, other: value) != 1) return 2;
  if (textLength(retained) != 6) return 3;
  const absent: objc.Object | null = null;
  if (textLength(absent) != 0) return 4;
  const proxy: objc.Object = native.ZObjectSource.proxy();
  if (proxy instanceof native.NSProxy) return 0;
  return 5;
}
