import { execSync } from "node:child_process";

execSync("ls"); // expect: error PERM003 exec

export const ready = true;
