export const BASE: i32 = 40;
export const DELTA: i32 = 2;
export const ENABLED: boolean = true;
export const LABEL: String = "native constants";
export const NATIVE_LABEL: cstring = "native-constants";

const INTERNAL_REVISION = 1;
const INTERNAL_RATIO = 1.5;

export function revision(): i32 {
  return INTERNAL_REVISION;
}

export function ratio(): f64 {
  return INTERNAL_RATIO;
}
