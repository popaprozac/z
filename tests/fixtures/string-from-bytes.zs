import { Utf8Error as DecodeError } from "std/text";

function decode(bytes: Slice<u8>): String throws DecodeError {
  return try String.fromBytes(bytes);
}

function verify(): i32 throws DecodeError {
  let bytes = Array<u8>(111, 107, 0, 195, 169);
  const text = try decode(bytes);
  bytes.clear();
  if (text.byteLength != 5 || text.byteAt(2) != 0 || text.byteAt(4) != 169) return 1;
  const empty = try String.fromBytes(bytes);
  if (empty.byteLength != 0) return 2;
  bytes.push(65);
  bytes.push(237);
  bytes.push(160);
  bytes.push(128);
  match (attempt String.fromBytes(bytes)) {
    success(_) => return 3;
    failure(error) => if (error.byteOffset != 1) return 4;
  }
  if (bytes.length != 4) return 5;
  const fixed: u8[4] = [u8(240), u8(159), u8(154), u8(128)];
  const rocket = try String.fromBytes(fixed);
  if (rocket != "🚀") return 6;
  const limits = Array<u8>(0, 127, 194, 128, 223, 191, 224, 160, 128,
    237, 159, 191, 238, 128, 128, 239, 191, 191, 240, 144, 128, 128,
    244, 143, 191, 191);
  const boundaryText = try String.fromBytes(limits);
  if (boundaryText.byteLength != limits.length) return 7;
  let index: usize = 0;
  while (index < limits.length) {
    if (boundaryText.byteAt(index) != limits[index]) return 8;
    index = index + 1;
  }
  return 0;
}

function main(): i32 {
  const invalid0 = Array<u8>(65, 195, 169, 128);
  match (attempt String.fromBytes(invalid0)) {
    success(_) => return 20;
    failure(error) => if (error.byteOffset != 3) return 50;
  }
  const invalid1 = Array<u8>(65, 195, 169, 191);
  match (attempt String.fromBytes(invalid1)) {
    success(_) => return 21;
    failure(error) => if (error.byteOffset != 3) return 51;
  }
  const invalid2 = Array<u8>(65, 195, 169, 192, 128);
  match (attempt String.fromBytes(invalid2)) {
    success(_) => return 22;
    failure(error) => if (error.byteOffset != 3) return 52;
  }
  const invalid3 = Array<u8>(65, 195, 169, 193, 191);
  match (attempt String.fromBytes(invalid3)) {
    success(_) => return 23;
    failure(error) => if (error.byteOffset != 3) return 53;
  }
  const invalid4 = Array<u8>(65, 195, 169, 194);
  match (attempt String.fromBytes(invalid4)) {
    success(_) => return 24;
    failure(error) => if (error.byteOffset != 3) return 54;
  }
  const invalid5 = Array<u8>(65, 195, 169, 194, 65);
  match (attempt String.fromBytes(invalid5)) {
    success(_) => return 25;
    failure(error) => if (error.byteOffset != 3) return 55;
  }
  const invalid6 = Array<u8>(65, 195, 169, 224, 128, 128);
  match (attempt String.fromBytes(invalid6)) {
    success(_) => return 26;
    failure(error) => if (error.byteOffset != 3) return 56;
  }
  const invalid7 = Array<u8>(65, 195, 169, 224, 160);
  match (attempt String.fromBytes(invalid7)) {
    success(_) => return 27;
    failure(error) => if (error.byteOffset != 3) return 57;
  }
  const invalid8 = Array<u8>(65, 195, 169, 225, 128, 65);
  match (attempt String.fromBytes(invalid8)) {
    success(_) => return 28;
    failure(error) => if (error.byteOffset != 3) return 58;
  }
  const invalid9 = Array<u8>(65, 195, 169, 237, 160, 128);
  match (attempt String.fromBytes(invalid9)) {
    success(_) => return 29;
    failure(error) => if (error.byteOffset != 3) return 59;
  }
  const invalid10 = Array<u8>(65, 195, 169, 240, 128, 128, 128);
  match (attempt String.fromBytes(invalid10)) {
    success(_) => return 30;
    failure(error) => if (error.byteOffset != 3) return 60;
  }
  const invalid11 = Array<u8>(65, 195, 169, 240, 144, 128);
  match (attempt String.fromBytes(invalid11)) {
    success(_) => return 31;
    failure(error) => if (error.byteOffset != 3) return 61;
  }
  const invalid12 = Array<u8>(65, 195, 169, 244, 144, 128, 128);
  match (attempt String.fromBytes(invalid12)) {
    success(_) => return 32;
    failure(error) => if (error.byteOffset != 3) return 62;
  }
  const invalid13 = Array<u8>(65, 195, 169, 245, 128, 128, 128);
  match (attempt String.fromBytes(invalid13)) {
    success(_) => return 33;
    failure(error) => if (error.byteOffset != 3) return 63;
  }
  const invalid14 = Array<u8>(65, 195, 169, 255);
  match (attempt String.fromBytes(invalid14)) {
    success(_) => return 34;
    failure(error) => if (error.byteOffset != 3) return 64;
  }
  return match (attempt verify()) {
    success(status) => status;
    failure(_) => 9;
  };
}
