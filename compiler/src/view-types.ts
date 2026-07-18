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
