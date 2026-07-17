const taskPrefix = "__z_task:";

export type TaskType = {
  readonly successType: string;
  readonly errorType: string | null;
};

export function taskTypeName(successType: string, errorType: string | null): string {
  return `${taskPrefix}${encodeURIComponent(JSON.stringify({ successType, errorType }))}`;
}

export function parseTaskType(name: string): TaskType | null {
  if (!name.startsWith(taskPrefix)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(name.slice(taskPrefix.length))) as TaskType;
    if (typeof value.successType !== "string") return null;
    if (value.errorType !== null && typeof value.errorType !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function displayTaskType(task: TaskType, display: (type: string) => string = (type) => type): string {
  const success = display(task.successType);
  return task.errorType ? `Task<${success}, ${display(task.errorType)}>` : `Task<${success}>`;
}
