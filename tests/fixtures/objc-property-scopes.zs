import native from "objc-property-scopes.h";

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
  return 0;
}
