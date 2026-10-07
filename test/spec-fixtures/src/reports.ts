// Two functions named build: a spec has to say which one it means.
import { execSync } from "node:child_process";

export namespace Reports {
  export function build() {
    return fetch("https://api.example.com/reports");
  }
}

export namespace Admin {
  export function build() {
    execSync("rm -rf /tmp/reports");
  }
}

// A getter and a setter share a name; a spec of the property checks both.
export class Settings {
  get theme() {
    return fetch("https://api.example.com/theme");
  }
  set theme(value: string) {
    execSync("defaults write theme " + value);
  }
}

// A top-level function, and one nested in another with the same name: the plain name means the
// top-level one.
export function make() {
  return fetch("https://api.example.com/make");
}

export function outer() {
  function make() {
    execSync("make");
  }
  return make();
}
