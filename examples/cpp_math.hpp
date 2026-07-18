#pragma once

namespace zcpp {

struct Point {
  int x;
  int y;
};

inline Point translate(Point point, int dx, int dy) {
  return Point { point.x + dx, point.y + dy };
}

inline int sum(Point point) {
  return point.x + point.y;
}

inline int scale(int value, int factor) {
  return value * factor;
}

inline double scale(double value, double factor) {
  return value * factor;
}

inline long choose(long value) {
  return value;
}

inline unsigned long choose(unsigned long value) {
  return value;
}

}  // namespace zcpp

namespace alpha {

struct Point {
  int value;
};

inline int adjust(int value) {
  return value + 1;
}

}  // namespace alpha

namespace beta {

struct Point {
  int value;
};

inline int adjust(int value) {
  return value - 1;
}

}  // namespace beta
