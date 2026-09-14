import native from "objc-string-lifetime.h";
import process from "std/process";

struct Labels { title: String; }

function message(): String { return `value=${42}`; }
function returned(): native.NSString { return message(); }
function returnedLocal(): native.NSString {
  const text = message();
  return text;
}
function returnedParameter(text: String): native.NSString { return text; }
function straightBorrow(): native.NSString {
  const text = message();
  return native.ZStringLifetimeOwner.echo(text);
}
function borrowed(in text: String): native.NSString {
  return native.ZStringLifetimeOwner.echoIn(in text);
}
function conditional(preferFirst: boolean): native.NSString {
  return preferFirst ? message() : `value=${7}`;
}
function mixed(text: String, preferStored: boolean): native.NSString {
  return preferStored ? text : message();
}
function mixedTemplate(text: String, preferStored: boolean): native.NSString {
  return preferStored ? text : `value=${42}`;
}

function main(): i32 {
  const args = process.args();
  if (args.length != 1) return 2;
  const owner = native.ZStringLifetimeOwner.alloc().init();
  if (args[0] == "literal") {
    owner.title = "value=42";
  } else if (args[0] == "move") {
    const title = message();
    owner.title = move title;
  } else if (args[0] == "borrow") {
    const title = message();
    owner.title = title;
    if (title != "value=42") return 3;
  } else if (args[0] == "copy") {
    const title = message();
    owner.title = native.ZStringLifetimeOwner.echo(copy title);
    if (title != "value=42") return 3;
  } else if (args[0] == "call") {
    owner.title = native.ZStringLifetimeOwner.echo(message());
  } else if (args[0] == "template") {
    owner.title = native.ZStringLifetimeOwner.echo(`value=${42}`);
  } else if (args[0] == "return") {
    owner.title = returned();
  } else if (args[0] == "return-local") {
    owner.title = returnedLocal();
  } else if (args[0] == "return-parameter") {
    owner.title = returnedParameter(message());
  } else if (args[0] == "straight-borrow") {
    owner.title = straightBorrow();
  } else if (args[0] == "borrowed-call-temporary") {
    owner.title = native.ZStringLifetimeOwner.echoIn(message());
  } else if (args[0] == "borrowed-template") {
    owner.title = native.ZStringLifetimeOwner.echoIn(`value=${42}`);
  } else if (args[0] == "in") {
    const title = message();
    owner.title = borrowed(in title);
    if (title != "value=42") return 3;
  } else if (args[0] == "field") {
    const labels = Labels({ title: message() });
    owner.title = labels.title;
    if (labels.title != "value=42") return 3;
  } else if (args[0] == "conditional") {
    owner.title = conditional(true);
    if (!conditional(false).isEqualToString("value=7")) return 3;
  } else if (args[0] == "mixed") {
    owner.title = mixed(message(), true);
    if (!mixed(message(), false).isEqualToString("value=42")) return 3;
  } else if (args[0] == "mixed-template") {
    owner.title = mixedTemplate(message(), true);
    if (!mixedTemplate(message(), false).isEqualToString("value=42")) return 3;
  } else return 2;
  return owner.title.isEqualToString("value=42") ? 0 : 1;
}
