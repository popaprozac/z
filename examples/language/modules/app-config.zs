export const APP_NAME: String = "Z module workspace";
export const DEFAULT_DX: i32 = 1;
export const DEFAULT_DY: i32 = -1;
export const AUDIT_MOVES: boolean = true;
export const NATIVE_COMPONENT: cstring = "z-module-example";

const CONFIG_REVISION = 1;

export function revision(): i32 {
  return CONFIG_REVISION;
}
