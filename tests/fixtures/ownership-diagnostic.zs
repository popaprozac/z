struct Resource {
  id: i32;
  deinit {}
}

function main(): i32 {
  const first = Resource({ id: 42 });
  const second = first;
  return first.id + second.id;
}
