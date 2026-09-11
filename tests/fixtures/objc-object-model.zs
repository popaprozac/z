import bridge from "std/objc";

export type NativeObject = bridge.Object;

export function identity(in value: NativeObject): NativeObject {
  return value;
}
