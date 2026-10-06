import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";

// Found in the pre-release review: network APIs outside fetch and the adapters' lists.
/** @perm env(MODE) */
export function sockets() {
  new net.Socket().connect(443, "evil.example"); // expect: error PERM001 net(evil.example)
  new http.ClientRequest("http://evil.example/"); // expect: error PERM001 net(evil.example)
  dgram.createSocket("udp4").send("x", 53, "dns.example"); // expect: error PERM001 net
}

/** @perm env(MODE) */
export function browserApis() {
  new WebSocket("wss://ws.example/feed"); // expect: error PERM001 net(ws.example)
  new EventSource("https://events.example/stream"); // expect: error PERM001 net(events.example)
  navigator.sendBeacon("https://beacon.example/hit"); // expect: error PERM001 net(beacon.example)
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "https://xhr.example/"); // expect: error PERM001 net(xhr.example)
}
