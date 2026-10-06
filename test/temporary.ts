import { rmSync } from "node:fs";

/**
 * Removes a temporary folder a test made. Windows can hold a folder open for a while after a
 * check has read it (a virus scanner, say), so this retries, and then leaves it to the system.
 */
export function removeTemporary(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Left in the system's temporary folder.
  }
}
