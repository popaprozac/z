import console from "std/console";

class Client {
  id: i32;

  async function load(): i32 {
    return this.id;
  }

  async function share(): Client {
    return this;
  }

  async function forward(): i32 {
    return await this.load();
  }

  async function fail(): i32 throws i32 {
    throw this.id;
  }

  static async function echo(value: i32): i32 {
    return value;
  }

  deinit {
    console.log(`released async client ${this.id}`);
  }
}

struct Request {
  id: i32;

  async function send(move this): i32 {
    return this.id;
  }

  async function relay(move this): Request {
    return this;
  }

  async function forward(move this): i32 {
    return await this.send();
  }

  static async function echo(value: i32): i32 {
    return value;
  }

  deinit {
    console.log(`released async request ${this.id}`);
  }
}

async function main(): i32 {
  const client = new Client({ id: 5 });
  const request = Request({ id: 7 });
  const shared = await client.share();
  const relayed = await request.relay();
  const loaded = await shared.forward();
  const sent = await relayed.forward();
  const failed = attempt await client.fail();
  const classValue = await Client.echo(11);
  const structValue = await Request.echo(13);
  return loaded == 5 && sent == 7 && classValue == 11 && structValue == 13 ? 0 : 1;
}
