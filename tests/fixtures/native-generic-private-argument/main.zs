import console from "std/console";
import { Pool, first } from "./pool.zs";

struct Entity { name: String; hp: i32; }

enum Mood { calm, loud }

function main(): i32 {
  const pool = Pool<Entity>({ values: Array<Entity>(Entity({ name: "a", hp: 1 })) });
  const moods = Pool<Mood>({ values: Array<Mood>(Mood.calm, Mood.loud) });
  const numbers = Array<i64>(i64(4), i64(5));
  console.log(`counts ${pool.count()} ${moods.count()}`);
  console.log(`with ${pool.countWith(numbers)} ${moods.countWith(numbers)}`);
  console.log(`first ${first(numbers, i64(0))}`);
  return 0;
}
