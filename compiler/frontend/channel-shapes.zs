import { Program } from "./parser.zs";
import { stringStartsWith } from "./semantic-type-shapes.zs";

export function programUsesChannels(in program: Program): boolean {
  for (const declaration of program.imports) {
    if (declaration.header == "std/channel") return true;
  }
  return false;
}

export function channelTypeKind(in program: Program, in base: String): String {
  if (base == "Channel.Endpoints" || base == "__z_ChannelEndpoints") return "Endpoints";
  for (const declaration of program.imports) {
    if (declaration.header != "std/channel") continue;
    if (base == "ChannelClosed") return "Closed";
    if (base == "Channel" || base == "Sender" || base == "Receiver"
      || base == "SyncSender" || base == "SyncReceiver") return copy base;
    for (const binding of declaration.bindings) {
      if (binding.localName != base) continue;
      const name = view binding.importedName;
      if (name == "ChannelClosed") return "Closed";
      if (name == "Channel" || name == "Sender" || name == "Receiver"
        || name == "SyncSender" || name == "SyncReceiver") {
        return copy binding.importedName;
      }
    }
  }
  return "";
}

export function channelIdentity(in kind: String, in payload: String): String {
  return `__z_Channel_${kind}_${payload}`;
}

export function isChannelType(in program: Program, in base: String): boolean {
  const kind = channelTypeKind(program, base);
  return kind.byteLength > 0;
}

export function channelIdentityKind(in name: String): String {
  const prefix = "__z_Channel_";
  if (!stringStartsWith(name, prefix)) return "";
  let end = prefix.byteLength;
  while (end < name.byteLength && name.byteAt(end) != 95) { end = end + 1; }
  return name.copyBytes(prefix.byteLength, end);
}

export function channelPayloadIdentity(in name: String): String {
  const kind = channelIdentityKind(name);
  if (kind.byteLength == 0) return "";
  return name.copyBytes(12 + kind.byteLength + 1, name.byteLength);
}

export function channelKindRetains(in kind: String): boolean {
  return kind == "Sender" || kind == "SyncSender";
}
