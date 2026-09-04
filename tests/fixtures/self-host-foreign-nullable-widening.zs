import Foundation from "Foundation/Foundation.h";

function value(): Foundation.NSString | null {
  const present: Foundation.NSString = "present";
  return present;
}

function main(): i32 {
  return value() == null ? 1 : 0;
}
