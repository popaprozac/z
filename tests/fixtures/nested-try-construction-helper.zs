export struct Size { width: u32; height: u32; }
export struct SizeError { message: String; }

function dimension(value: u32): u32 throws SizeError {
  if (value == 0) throw SizeError({ message: "zero dimension" });
  return value;
}

export function size(width: u32, height: u32): Size throws SizeError {
  return Size({ width: try dimension(width), height: try dimension(height) });
}
