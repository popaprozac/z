import { genericTypeName, parseGenericType } from "./generic-types.ts";

export type ChannelHandleKind =
  | "factory"
  | "sender"
  | "receiver"
  | "syncSender"
  | "syncReceiver"
  | "endpoints"
  | "closed";

export type ChannelHandleType = {
  readonly kind: ChannelHandleKind;
  readonly valueType: string;
};

const bases: Readonly<Record<ChannelHandleKind, string>> = {
  factory: "Channel",
  sender: "Sender",
  receiver: "Receiver",
  syncSender: "SyncSender",
  syncReceiver: "SyncReceiver",
  endpoints: "__z_ChannelEndpoints",
  closed: "ChannelClosed",
};

function typeName(kind: ChannelHandleKind, valueType: string): string {
  return genericTypeName(bases[kind], [valueType]);
}

export function channelFactoryTypeName(valueType: string): string {
  return typeName("factory", valueType);
}

export function channelSenderTypeName(valueType: string): string {
  return typeName("sender", valueType);
}

export function channelReceiverTypeName(valueType: string): string {
  return typeName("receiver", valueType);
}

export function channelSyncSenderTypeName(valueType: string): string {
  return typeName("syncSender", valueType);
}

export function channelSyncReceiverTypeName(valueType: string): string {
  return typeName("syncReceiver", valueType);
}

export function channelEndpointsTypeName(valueType: string): string {
  return typeName("endpoints", valueType);
}

export function channelClosedTypeName(valueType: string): string {
  return typeName("closed", valueType);
}

export function parseChannelHandleType(name: string): ChannelHandleType | null {
  const generic = parseGenericType(name);
  if (!generic || generic.arguments.length !== 1) return null;
  const entry = (Object.entries(bases) as Array<[ChannelHandleKind, string]>)
    .find(([, base]) => generic.base === base);
  return entry ? { kind: entry[0], valueType: generic.arguments[0] } : null;
}

export function isChannelEndpointType(name: string): boolean {
  const channel = parseChannelHandleType(name);
  return channel?.kind === "sender"
    || channel?.kind === "receiver"
    || channel?.kind === "syncSender"
    || channel?.kind === "syncReceiver";
}
