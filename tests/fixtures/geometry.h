#ifndef Z_TEST_GEOMETRY_H
#define Z_TEST_GEOMETRY_H

typedef int ZCount;
typedef unsigned short ZExtent;
typedef unsigned int ZFlags;
typedef unsigned long long ZIdentifier;
typedef double ZCoordinate;

typedef struct ZPoint {
  int x;
  int y;
} ZPoint;

typedef enum ZDirection {
  ZForward = 1,
  ZBackward = -1
} ZDirection;

typedef struct ZSize {
  ZExtent width;
  ZExtent height;
} ZSize;

typedef struct ZRect {
  ZPoint origin;
  ZSize size;
  ZFlags flags;
  ZIdentifier identifier;
} ZRect;

static inline ZPoint z_translate(ZPoint point, ZDirection direction, ZCount amount) {
  point.x += direction * amount;
  return point;
}

static inline int z_score(ZPoint point) {
  return point.x + point.y;
}

static inline void z_offset(ZPoint *point, int dx, int dy) {
  point->x += dx;
  point->y += dy;
}

static inline void z_reset(ZPoint *point) {
  point->x = 5;
  point->y = 6;
}

static inline int z_read(const ZPoint *point) {
  return point->x + point->y;
}

static inline unsigned int z_extent_value(ZExtent value) {
  return value;
}

static inline ZIdentifier z_rect_id(ZRect rect) {
  return rect.identifier;
}

static inline ZCoordinate z_area(ZCoordinate width, ZCoordinate height) {
  return width * height;
}

#endif
