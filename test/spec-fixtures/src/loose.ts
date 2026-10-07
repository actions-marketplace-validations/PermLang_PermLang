// Calls through values typed `any`: what runs can't be seen.
import { lib, run } from "loose-run";

export function viaAnyExport(id: string) {
  run("rm -rf /" + id);
}

export function viaAnyIndex(id: string) {
  lib.exec("rm -rf /" + id);
}

export function viaParsed(json: string) {
  new (JSON.parse(json).Sender)().send();
}

export function viaHelper(id: string) {
  viaAnyExport(id);
}

// Typed all the way: checked as usual.
export function shout(id: string) {
  return id.toUpperCase();
}

// A tagged template, and a name long enough to be shortened in the message.
export function viaTag(id: string) {
  return lib.sql`select ${id}`;
}

export function viaLong(json: string) {
  JSON.parse(json).aVeryLongPropertyNameThatGoesOnAndOn.anotherQuiteLongPropertyName.send();
}

// What a module loaded at run time gives is followed as a module, not as a call through any.
export function viaRequire(id: string) {
  require("loose-run").run(id);
}

export async function viaImport() {
  (await import("./nowhere.js")).go();
}

// Both kinds at once.
import { pingUntyped } from "no-such-pinger";
export function viaBoth(id: string) {
  run(id);
  pingUntyped(id);
}
