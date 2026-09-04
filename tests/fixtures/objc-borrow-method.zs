import native from "./objc-borrow-method.h";

function echo(in value: String): String {
  const echoed: String = native.ZObjCBorrowMethodFixture.echo(in value);
  return echoed;
}

function main(): i32 {
  const text = "borrowed";
  const echoed = echo(in text);
  return echoed.byteLength == text.byteLength ? 0 : 1;
}
