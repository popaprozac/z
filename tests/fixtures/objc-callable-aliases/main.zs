import local from "Foundation/Foundation.h";
import { TextOperation, invoke, echo, Reader } from "./contract.zs";

function apply(in value: local.NSString): local.NSString | null {
  const reader = new Reader({});
  const callback: TextOperation = move (in value): local.NSString | null => {
    return reader.echo(in value);
  };
  const first = invoke(callback, in value);
  if (first == null) return null;
  const direct: TextOperation = (in value): local.NSString | null => echo(in value);
  return invoke(direct, in first);
}

function main(): i32 {
  const text = local.NSString.alloc().initWithUTF8String("hello");
  if (text == null) return 1;
  const reader = new Reader({});
  const operation: TextOperation = move (in value: local.NSString): local.NSString | null => {
    if (text.length == 5) return reader.echo(in value);
    return null;
  };
  const result = invoke(operation, in text);
  if (result == null) return 2;
  const direct: TextOperation = (in value: local.NSString): local.NSString | null => echo(in value);
  const other = invoke(direct, in result);
  if (other == null) return 3;
  const forwarded = apply(in other);
  if (forwarded == null) return 4;
  return forwarded.length == 5 ? 0 : 5;
}
