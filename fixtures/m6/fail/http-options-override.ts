import http from "node:http";

declare function lookupHost(): string;
declare const options: http.RequestOptions;

// Found in the pre-release review: Node's options object overrides the URL's host.
/** @perm net(good.example) */
export function override() {
  http.request("http://good.example/", { hostname: "evil.example" }); // expect: error PERM001 net(evil.example)
  http.get("http://good.example/", { hostname: lookupHost() }); // expect: error PERM001 net
  http.request("http://good.example/", options); // expect: error PERM001 net
}
