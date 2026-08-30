import objc from "std/objc";
import native from "objc-autorelease-pool.h";

struct PoolError {
  code: i32;
}

function failInsidePool(): void throws PoolError {
  try objc.pool((): void throws PoolError => {
    const probe = native.ZObjCAutoreleaseProbe.makeAutoreleased();
    throw PoolError({ code: 9 });
  });
}

function main(): i32 {
  const liveInside = objc.pool((): i32 => {
    const probe = native.ZObjCAutoreleaseProbe.makeAutoreleased();
    return native.z_objc_autorelease_live();
  });
  const liveAfter = native.z_objc_autorelease_live();
  const failure = attempt failInsidePool();
  const failureStatus = match (failure) {
    success => 1;
    failure(error) => error.code == 9 ? 0 : 2;
  };
  const retained = objc.pool((): native.ZObjCAutoreleaseProbe => {
    return native.ZObjCAutoreleaseProbe.makeAutoreleased();
  });
  const retainedStatus = retained.currentLive() == 1 ? 0 : 3;
  return liveInside - 1
    + liveAfter
    + failureStatus
    + retainedStatus;
}
