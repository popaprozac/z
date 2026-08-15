import { Set } from "std/collections";
import { Hashable, Hasher } from "std/hash";

readonly struct RouteKey implements Hashable {
  package: String;
  route: String;

  function equals(in other: RouteKey): boolean {
    return this.package == other.package && this.route == other.route;
  }

  function hash(inout hasher: Hasher): void {
    hasher.add(this.package);
    hasher.add(this.route);
  }
}

function main(): i32 {
  let ordinals = Set<i32>();
  if (!ordinals.add(20)) return 1;
  if (ordinals.add(20)) return 2;
  const removedOrdinal = ordinals.remove(20);
  const ordinal = match (removedOrdinal) {
    some(value) => value;
    none => 0;
  };
  if (ordinal != 20 || ordinals.has(20)) return 3;

  let routes = Set<RouteKey>();
  if (!routes.add(RouteKey({ package: "std", route: "collections" }))) return 4;
  if (routes.add(RouteKey({ package: "std", route: "collections" }))) return 5;
  const lookup = RouteKey({ package: "std", route: "collections" });
  if (!routes.has(lookup)) return 6;
  const removedRoute = routes.remove(lookup);
  const routeBytes = match (removedRoute) {
    some(value) => i32(value.route.byteLength);
    none => 0;
  };
  if (routeBytes != 11) return 7;
  if (routes.delete(lookup)) return 8;

  routes.add(RouteKey({ package: "std", route: "hash" }));
  routes.clear();
  if (routes.length != 0) return 9;
  routes.add(RouteKey({ package: "std", route: "memory" }));
  return routes.delete(RouteKey({ package: "std", route: "memory" }))
    ? 0
    : 10;
}
