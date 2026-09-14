import native from "Foundation/Foundation.h";

export type TextOperation = (in value: native.NSString) => native.NSString | null;

export function invoke(operation: TextOperation, in value: native.NSString): native.NSString | null {
  return operation(in value);
}
