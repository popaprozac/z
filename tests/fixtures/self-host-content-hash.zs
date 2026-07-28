import { sha256 } from "../../compiler/driver/content-hash.zs";

function main(): i32 {
  let empty = Array<u8>();
  if (
    sha256(empty)
      != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  ) return 1;

  let abc = Array<u8>();
  abc.push(97);
  abc.push(98);
  abc.push(99);
  if (
    sha256(abc)
      != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  ) return 2;

  return 0;
}
