import { size } from "./nested-try-construction-helper.zs";

function main(): i32 {
  match (attempt size(640, 480)) {
    success(value) => if (value.width != 640 || value.height != 480) return 1;
    failure(_) => return 2;
  }
  match (attempt size(0, 480)) {
    success(_) => return 3;
    failure(error) => if (error.message != "zero dimension") return 4;
  }
  match (attempt size(640, 0)) {
    success(_) => return 5;
    failure(error) => if (error.message != "zero dimension") return 6;
  }
  return 0;
}
