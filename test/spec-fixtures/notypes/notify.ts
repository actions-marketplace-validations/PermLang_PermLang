import { spawn } from "node:child_process";

export function notifyOps(id: string) {
  spawn("notify-ops", [id]);
}
