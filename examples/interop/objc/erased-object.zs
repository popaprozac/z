import objc from "std/objc";
import console from "std/console";
import Foundation from "Foundation/Foundation.h";

// An unknown native class is still an Objective-C object, not a Z `any`.
function textLength(in value: objc.Object | null): usize {
  if (value instanceof Foundation.NSString) {
    const text: String = value;
    return text.byteLength;
  }
  return 0;
}

function main(): i32 {
  // Make the String -> NSString bridge explicit before erasing its class.
  const nativeText: Foundation.NSString = "native identity";
  const object: objc.Object = nativeText;
  const absent: objc.Object | null = null;
  console.log(`${textLength(object)}`); // 15
  console.log(`${textLength(absent)}`); // 0
  return 0;
}
