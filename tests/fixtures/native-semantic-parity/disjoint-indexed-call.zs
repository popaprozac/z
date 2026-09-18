import console from "std/console";

struct Bucket { values: Array<i32>; }
struct Lists {
  next: Array<i32>;
  buckets: Bucket;
  function carry(inout this, bucket: usize): void {
    this.next.push(this.buckets.values[bucket]);
  }
}

function main(): i32 {
  let lists = Lists({ next: Array<i32>(), buckets: Bucket({ values: Array<i32>(5, 9) }) });
  lists.carry(0);
  lists.carry(1);
  if (lists.next.length != 2 || lists.next[0] != 5 || lists.next[1] != 9) return 1;
  console.log("ok");
  return 0;
}
