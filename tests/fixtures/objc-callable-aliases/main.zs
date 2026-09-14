import local from "Foundation/Foundation.h";
import { TextOperation, invoke } from "./contract.zs";

function main(): i32 {
  const text = local.NSString.alloc().initWithUTF8String("hello");
  if (text == null) return 1;
  const operation: TextOperation = move (in value: local.NSString): local.NSString | null => {
    if (text.length == 5) return value;
    return null;
  };
  const result = invoke(operation, in text);
  if (result == null) return 2;
  const direct: TextOperation = (in value: local.NSString): local.NSString | null => value;
  const other = invoke(direct, in result);
  if (other == null) return 3;
  return other.length == 5 ? 0 : 4;
}
