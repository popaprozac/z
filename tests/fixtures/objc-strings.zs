import console from "std/console";
import Foundation from "Foundation/Foundation.h";
import Native from "objc-strings.h";

function main(): i32 {
  const computed = `answer=${40 + 2}`;
  const nativeComputed = Native.ZObjCStringFixture.echo(computed);
  const roundTrip: String = nativeComputed;
  console.log(`round trip=${roundTrip}`);

  const embedded: String = Native.ZObjCStringFixture.embeddedNull();
  const nativeEmbedded = Native.ZObjCStringFixture.echo(embedded);
  const embeddedRoundTrip: String = nativeEmbedded;
  console.log(`embedded=${embeddedRoundTrip}`);
  return 0;
}
