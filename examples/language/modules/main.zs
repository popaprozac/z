import console from "std/console";
import appConfig from "./app-config.zs";
import { APP_NAME as appName } from "./app-config.zs";
import geometry from "./geometry.zs";
import { translate as move } from "./geometry.zs";

function main(): i32 {
  const origin = geometry.Point({ x: 20, y: 22 });
  const moved = move(origin, appConfig.DEFAULT_DX, appConfig.DEFAULT_DY);
  const audit = appConfig.AUDIT_MOVES ? "enabled" : "disabled";
  console.log(
    `${appName} revision=${appConfig.revision()}, audit=${audit}, point=${moved}, total=${geometry.total(moved)}`
  );
  return 0;
}
