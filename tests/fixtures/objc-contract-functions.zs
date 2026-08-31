import native from "./objc-contract-functions.h";

function inspect(
  in value: native.NSString,
  in object: native.NSObject
): usize {
  native.z_objc_contract_observe(in object, true);
  return native.z_objc_contract_length(in value);
}

function main(): i32 {
  return 0;
}
