import Foundation from "Foundation/Foundation.h";

function choose(accepted: boolean): Foundation.NSString {
  const reply: Foundation.NSString = accepted ? "accepted" : "rejected";
  return reply;
}

function template(accepted: boolean): Foundation.NSString {
  return accepted ? `value=${42}` : `value=${7}`;
}

function main(): i32 {
  const yes = choose(true);
  const no = choose(false);
  if (!yes.isEqualToString("accepted") || !no.isEqualToString("rejected")) return 1;
  const generated = template(true);
  const other = template(false);
  if (!generated.isEqualToString("value=42") || !other.isEqualToString("value=7")) return 2;
  const roundTrip: String = true ? yes : no;
  if (roundTrip != "accepted") return 3;
  return 0;
}
