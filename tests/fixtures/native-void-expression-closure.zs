import console from "std/console";

function apply(in action: () => void): void {
  action();
}

function main(): i32 {
  apply((): void => console.log("applied"));
  const announce = (): void => console.log("announced");
  announce();
  return 0;
}
