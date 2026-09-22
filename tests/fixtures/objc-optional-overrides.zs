import native from "objc-optional-overrides.h";
import { thread } from "std/thread";
import objc from "std/objc";

function readDropValue(in info: native.ZDropInfo): i32 on thread.main {
  if (info.value < 0) return -1;
  let total = 0;
  let index = 0;
  while (index < 2) {
    if (index == 0) { total = total + info.value; }
    else { total = total - info.value; }
    index = index + 1;
  }
  // The protocol proof survives early-return, loop, and two-way branch joins.
  if (total != 0) return -1;
  return info.value;
}

class Destination extends native.ZCallbackDestination on thread.main {
  constructor() { super.init(); }

  override function accept(in info: native.ZDropInfo): i32 as "acceptInfo:" {
    const value = readDropValue(in info);
    const caption = info.caption;
    const position = info.position;
    if (caption.length != 5 || position.x != 3 || position.y != 4) return -1;
    if (readDropValue(in info) != value) return -4;
    const forwarded = objc.optionalCall(super.optionalInfo(info));
    match (in forwarded) { some(result) => { if (result != value) return -2; } none => return -3; }
    return value + 7;
  }

  override function inherited(): i32 as "inheritedValue" {
    const absent = objc.optionalCall(super.missingIncrement(native.z_callback_argument()));
    match (in absent) { some(_) => return -10; none => {} }
    const present = objc.optionalCall(super.optionalIncrement(native.z_callback_argument()));
    match (in present) { some(value) => { if (value != 43) return -11; } none => return -12; }
    objc.optionalCall(super.missingNote(native.z_callback_argument()));
    objc.optionalCall(super.optionalNote(native.z_callback_argument()));
    if (native.z_callback_argument_count() != 2 || native.z_callback_note_count() != 2) return -13;
    const flag = objc.optionalCall(super.optionalFlag());
    match (in flag) { some(value) => { if (value) return -14; } none => return -15; }
    const point = objc.optionalCall(super.optionalPoint());
    match (in point) { some(value) => { if (value.x != 3 || value.y != 4) return -16; } none => return -17; }
    const title = objc.optionalCall(super.optionalTitle());
    match (in title) { some(value) => { if (value.length != 8) return -18; } none => return -19; }
    const emptyTitle = objc.optionalCall(super.optionalNullableTitle());
    match (in emptyTitle) { some(value) => { if (value != null) return -20; } none => return -21; }
    const missingTitle = objc.optionalCall(super.missingNullableTitle());
    match (in missingTitle) { some(_) => return -22; none => {} }
    const token = objc.optionalCall(super.optionalToken());
    match (in token) { some(value) => { if (value.value != 42) return -23; } none => return -24; }
    const nullableToken = objc.optionalCall(super.optionalNullableToken());
    match (in nullableToken) {
      some(value) => { if (value == null) return -25; if (value.value != 42) return -26; }
      none => return -27;
    }
    return super.inheritedValue() + 1;
  }

  override function optionalValue(): i32 as "optionalValue" {
    const inherited = objc.optionalCall(super.optionalValue());
    return match (in inherited) { some(value) => value; none => 42; };
  }
}

function main(): i32 on thread.main {
  native.z_callback_prepare();
  const target = new Destination();
  if (native.z_callback_dispatch(target) != 42) return 1;
  if (target.optionalValue() != 42) return 2;
  const inherited = native.z_callback_inherited(target);
  if (inherited != 8) return 100 - inherited;
  if (native.z_callback_token_count() != 0) return 4;
  return 0;
}
