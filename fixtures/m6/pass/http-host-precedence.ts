import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// Options that name the same host, or that only add a path, a port, headers, or a callback.
/** @perm net(good.example) */
export function fine() {
  const hostname = "good.example";
  https.get({ hostname, path: "/x" });
  http.request({ hostname: "good.example", host: "good.example:8080" });
  // The URL's host wins over the options' host: Node reads `hostname` first, and the URL sets it.
  https.get("https://good.example/", { host: "other.example" });
  https.get("https://good.example/", { headers: { a: "b" }, port: 8443 }, (res) => res.resume());
  net.connect({ host: "good.example", port: 443 });
  tls.connect({ host: "good.example", port: 443, servername: "good.example" });
  net.connect(443, "good.example");
}

// Options after a port and host that don't redirect the connection.
/** @perm net(good.example) */
export function portAndHost() {
  tls.connect(443, "good.example", { servername: "good.example" });
}
