import macros from "./macro-constants.h";

function main(): i32 {
  return macros.Z_MACRO_ANSWER
    + macros.Z_STATIC_ANSWER
    + macros.Z_MACRO_NEGATIVE
    - 77;
}
