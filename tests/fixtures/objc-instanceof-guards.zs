import native from "./objc-instanceof.h";

function guarded(in owner: native.ZObjCDynamicOwner): i32 {
  const body = owner.body;
  if (!(body instanceof native.NSString)) return -1;
  const text: String = body;
  return i32(text.byteLength);
}

function guardedCompound(in owner: native.ZObjCDynamicOwner, disabled: boolean): i32 {
  const body = owner.body;
  if (!(body instanceof native.NSString) || disabled) return -1;
  const text: String = body;
  return i32(text.byteLength);
}

function conjunction(in owner: native.ZObjCDynamicOwner): i32 {
  const body = owner.body;
  if (body instanceof native.NSString && body.length > 0) {
    const text: String = body;
    return i32(text.byteLength);
  }
  return -1;
}

function otherwise(in owner: native.ZObjCDynamicOwner): i32 {
  const body = owner.body;
  if (!(body instanceof native.NSString)) return -1;
  else {
    const text: String = body;
    return i32(text.byteLength);
  }
}

function main(): i32 {
  const owner = native.ZObjCDynamicOwner.sharedOwner();
  if (guarded(owner) != 12) return 1;
  if (guardedCompound(owner, false) != 12) return 2;
  if (guardedCompound(owner, true) != -1) return 3;
  if (conjunction(owner) != 12) return 4;
  if (otherwise(owner) != 12) return 5;
  return 0;
}
