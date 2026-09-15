// Unsigned representation carriers for the intrinsic toBits/fromBits pair.
// Unsigned values are already carriers and have no identity bit methods.
export function numericBitsType(type: string): string | null {
  switch (type) {
    case "i8": return "u8";
    case "i16": return "u16";
    case "i32":
    case "f32": return "u32";
    case "i64":
    case "f64": return "u64";
    case "isize": return "usize";
    default: return null;
  }
}
