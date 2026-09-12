import embed from "std/embed";

const ICON = embed.bytes("./embedded-constant-inference.zs");
struct Options { bytes: embed.StaticBytes; }

function read(options: Options): usize { return options.bytes.length; }
function main(): i32 {
  const options = Options({ bytes: ICON });
  if (read(options) == 0 || ICON.length != options.bytes.length) return 1;
  return 0;
}
