// Async methods in general native frames: a class receiver stays retained
// across suspension, a `move this` struct receiver is owned by the frame
// (and moved on into a child), frames await methods as children, and static
// async methods await like named functions.
import console from "std/console";
import { delay } from "std/time";

class Client {
  id: i32;

  async function load(): i32 {
    await delay(1);
    return this.id;
  }

  async function share(): Client {
    return this;
  }

  async function forward(): i32 {
    const value = await this.load();
    await delay(1);
    return value + 1;
  }

  async function fail(): i32 throws i32 {
    await delay(1);
    throw this.id;
  }

  static async function echo(value: i32): i32 {
    await delay(1);
    return value;
  }

  deinit {
    console.log(`released client ${this.id}`);
  }
}

struct Request {
  id: i32;

  async function send(move this): i32 {
    await delay(1);
    return this.id;
  }

  async function forward(move this): i32 {
    await delay(1);
    return await this.send();
  }

  static async function echo(value: i32): i32 {
    return value;
  }

  deinit {
    console.log(`released request ${this.id}`);
  }
}

async function main(): i32 {
  const client = new Client({ id: 5 });
  const shared = await client.share();
  const forwarded = await shared.forward();
  const other = new Client({ id: 9 });
  const temporary = await other.load();
  console.log(`forwarded ${forwarded} temporary ${temporary}`);
  const sent = await Request({ id: 7 }).forward();
  const failed = attempt await client.fail();
  const code = match (failed) {
    success(value) => value;
    failure(error) => error;
  };
  const classEcho = await Client.echo(11);
  const structEcho = await Request.echo(13);
  console.log(`sent ${sent} code ${code} echoes ${classEcho} ${structEcho}`);
  return forwarded - 6 + temporary - 9 + sent - 7 + code - 5 + classEcho - 11 + structEcho - 13;
}
