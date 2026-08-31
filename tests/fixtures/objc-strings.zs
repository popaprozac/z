import console from "std/console";
import Foundation from "Foundation/Foundation.h";
import Native from "objc-strings.h";

function generatedMessage(): String {
  return `answer=${40 + 2}`;
}

function main(): i32 {
  const computed = generatedMessage();
  const nativeComputed = Native.ZObjCStringFixture.echo(copy computed);
  const directNativeComputed = Native.ZObjCStringFixture.echo(generatedMessage());
  if (!directNativeComputed.isEqualToString("answer=42")) return 1;
  const descriptionKey: Foundation.NSString =
    Foundation.NSLocalizedDescriptionKey;
  if (!descriptionKey.isEqualToString("NSLocalizedDescription")) return 3;
  const roundTrip: String = nativeComputed;
  console.log(`round trip=${roundTrip}`);

  // Objective-C class identities are global even when independent imported
  // headers surface the same NSString declaration under different namespaces.
  const nativeNullable: Foundation.NSString =
    Native.ZObjCStringFixture.echoNullable(copy computed);
  const nullableRoundTrip: String = nativeNullable;
  console.log(`nullable=${nullableRoundTrip}`);

  const maybe: Foundation.NSString | null =
    Native.ZObjCStringFixture.maybe(computed);
  if (maybe == null || !maybe.isEqualToString("answer=42")) return 2;
  const maybeAnd: Foundation.NSString | null =
    Native.ZObjCStringFixture.maybe("answer=42");
  if (maybeAnd != null && maybeAnd.isEqualToString("answer=42")) {
    console.log("narrowed=yes");
  }

  const embedded: String = Native.ZObjCStringFixture.embeddedNull();
  const nativeEmbedded = Native.ZObjCStringFixture.echo(embedded);
  const embeddedRoundTrip: String = nativeEmbedded;
  console.log(`embedded=${embeddedRoundTrip}`);
  return 0;
}
