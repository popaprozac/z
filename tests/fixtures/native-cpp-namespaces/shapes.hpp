#pragma once

namespace geometry {

struct Point {
  int x;
  int y;
};

inline int area(Point point) { return point.x * point.y; }
inline int widen(int value) { return value * 2; }
inline double widen(double value) { return value * 2.5; }
inline long long pick(long long value) { return value - 1; }
inline unsigned long long pick(unsigned long long value) { return value + 1; }
inline long span(long value) { return value * 3; }

namespace inner {
inline int depth(int value) { return value + 100; }
}  // namespace inner

}  // namespace geometry

namespace labels {

struct Point {
  int id;
};

inline int tag(Point point) { return point.id * 10; }

}  // namespace labels
