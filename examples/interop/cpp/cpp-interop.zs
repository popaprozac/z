import console from "std/console";
import cpp from "cpp_math.hpp";

function main(): i32 {
  const origin: cpp.zcpp.Point = cpp.zcpp.Point({ x: 20, y: 22 });
  const alphaPoint: cpp.alpha.Point = cpp.alpha.Point({ value: 20 });
  const betaPoint: cpp.beta.Point = cpp.beta.Point({ value: 20 });
  const moved = cpp.zcpp.translate(origin, 1, -1);
  const integerScale = cpp.scale(6, 7);
  const floatingScale = cpp.zcpp.scale(2.5, 2.0);
  const adjusted = cpp.alpha.adjust(alphaPoint.value) + cpp.beta.adjust(betaPoint.value);
  console.log(`cpp=${cpp.sum(moved)}, integer=${integerScale}, floating=${floatingScale}, adjusted=${adjusted}, point=${moved}`);
  return 0;
}
