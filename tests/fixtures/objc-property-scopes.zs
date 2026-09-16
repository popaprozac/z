import native from "objc-property-scopes.h";

struct PropertyOwner {
  object: native.ZPropertyScopeBase;
  deinit { this.object.writableValue = 73; }
}

function scopedProperty(object: native.ZPropertyScopeBase): i32 {
  const owner = PropertyOwner({ object });
  // The struct binding stays immutable; this invokes the native object's
  // setter, not an assignment to owner.object storage.
  owner.object.writableValue = 72;
  return owner.object.writableValue;
}

function main(): i32 {
  const base = native.ZPropertyScopeBase.alloc().init();
  const child = native.ZPropertyScopeChild.alloc().init();
  const instanceValue: i32 = base.value;
  const classValue: f64 = native.ZPropertyScopeBase.value;
  const inheritedClassValue: f64 = native.ZPropertyScopeChild.value;
  if (instanceValue != 11 || classValue != 22.5 || inheritedClassValue != 22.5) return 1;
  if (child.value != 41) return 2;
  if (base.marker != 31 || child.marker != 31) return 3;
  if (native.ZPropertyScopeChild.marker != 51) return 4;
  native.ZPropertyScopeBase.shared.writableValue = 61;
  if (native.ZPropertyScopeBase.shared.writableValue != 61) return 5;
  // Repeated inherited property spellings must retain their native record and
  // nullable object representations when lowering memoizes type lookups.
  if (base.span.location != 2 || base.span.length != 3) return 6;
  if (child.span.location != 5 || child.span.length != 7) return 7;
  if (base.caption != null || child.caption != null) return 8;
  if (scopedProperty(base) != 72 || base.writableValue != 73) return 9;
  return 0;
}
