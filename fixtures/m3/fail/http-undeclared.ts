import http from "node:http";
import https from "node:https";
import net from "node:net";

/** @perm net(api.github.com) */
export function sneaky() {
  https.get("https://evil.example/x"); // expect: error PERM001 net(evil.example)
  http.request({ host: "internal.example:8080", path: "/" }); // expect: error PERM001 net(internal.example)
  net.connect(5432, "db.example"); // expect: error PERM001 net(db.example)
}
