import Foundation from "Foundation/Foundation.h";
import native from "objc-instanceof.h";

function bodyLength(in owner: native.ZObjCDynamicOwner): i32 {
  const body = owner.body;
  if (body instanceof Foundation.NSString) {
    const text: String = body;
    return i32(text.byteLength);
  }
  return -1;
}

function main(): i32 {
  const owner = native.ZObjCDynamicOwner.sharedOwner();
  return bodyLength(owner);
}
