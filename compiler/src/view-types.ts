import { parseOptionType } from "./option-types.ts";

const viewPrefix = "__z_view:";

export type ViewType = {
  readonly target: string;
};

export function viewTypeName(target: string): string {
  return `${viewPrefix}${target}`;
}

export function parseViewType(name: string): ViewType | null {
  return name.startsWith(viewPrefix)
    ? { target: name.slice(viewPrefix.length) }
    : null;
}

export function parseOptionalViewType(name: string): ViewType | null {
  const option = parseOptionType(name);
  return option ? parseViewType(option.target) : null;
}

export function parseReceiverViewReturnType(name: string): ViewType | null {
  return parseViewType(name) ?? parseOptionalViewType(name);
}
