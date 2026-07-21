import console from "std/console";

struct Resource {
  id: i32;

  deinit {
    console.log(`released resource ${this.id}`);
  }
}

class Session {
  id: i32;

  deinit {
    console.log(`released session ${this.id}`);
  }
}

async function makeResource(id: i32): Resource {
  return Resource({ id });
}

async function inspectResource(resource: Resource): i32 {
  return resource.id;
}

async function relayResource(resource: Resource): Resource {
  return resource;
}

async function makeSession(id: i32): Session {
  return new Session({ id });
}

async function shareSession(session: Session): Session {
  return session;
}

async function main(): i32 {
  const resource = await makeResource(40);
  const relayed = await relayResource(resource);
  const resourceId = await inspectResource(relayed);
  const first = await makeSession(42);
  const second = await shareSession(first);
  return resourceId == 40 && second.id == 42 ? 0 : 1;
}
