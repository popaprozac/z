import json from "std/json";

readonly struct MenuItem {
  label: String;
  enabled: boolean = true;
  children: Array<MenuItem> = Array<MenuItem>();
}

readonly struct MenuDefinition {
  owner: String;
  items: Array<MenuItem>;
}

function rejects(in source: String): boolean {
  const decoded = attempt json.decode<MenuDefinition>(in source);
  return match (decoded) {
    success(_) => false;
    failure(_) => true;
  };
}

function main(): i32 {
  const decoded = attempt json.decode<MenuDefinition>(
    '{"owner":"window-1","items":[{"label":"File","children":[{"label":"New","enabled":false}]}]}'
  );
  const verified = match (decoded) {
    success(menu) => {
      if (menu.owner != "window-1") return 1;
      if (menu.items.length != 1) return 2;
      if (menu.items[0].label != "File") return 3;
      if (!menu.items[0].enabled) return 4;
      if (menu.items[0].children.length != 1) return 5;
      if (menu.items[0].children[0].label != "New") return 6;
      if (menu.items[0].children[0].enabled) return 7;
      select 0;
    }
    failure(_) => 8;
  };
  if (verified != 0) return verified;
  if (!rejects('{"owner":"window-1","items":[{"label":"File","children":[{}]}]}')) return 9;
  if (!rejects('{"owner":"window-1","items":[{"label":"File","children":42}]}')) return 10;
  return 0;
}
