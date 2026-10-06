import axios from "axios";

declare const config: object;
declare const target: string;

// Options objects for libraries other than Node's own: every host they name must agree, and
// a spread or a redirecting option (socketPath, lookup, createConnection) could go anywhere.
/** @perm net(good.example) */
export async function options() {
  await axios({ url: "https://good.example/", hostname: "evil.example" }); // expect: error PERM001 net
  await axios({ url: "https://good.example/", ...config }); // expect: error PERM001 net
  await axios({ url: "https://good.example/", socketPath: "/var/run/docker.sock" }); // expect: error PERM001 net
  await axios({ url: target }); // expect: error PERM001 net
}

/** @perm net(good.example) */
export async function accessor() {
  await axios({ get url() { return "https://evil.example/"; } }); // expect: error PERM001 net
}
