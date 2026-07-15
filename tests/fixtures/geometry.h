#ifndef Z_TEST_GEOMETRY_H
#define Z_TEST_GEOMETRY_H

typedef int ZCount;

typedef struct ZPoint {
  int x;
  int y;
} ZPoint;

typedef enum ZDirection {
  ZForward = 1,
  ZBackward = -1
} ZDirection;

static inline ZPoint z_translate(ZPoint point, ZDirection direction, ZCount amount) {
  point.x += direction * amount;
  return point;
}

static inline int z_score(ZPoint point) {
  return point.x + point.y;
}

#endif
