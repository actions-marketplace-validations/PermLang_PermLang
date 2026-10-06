import axios from "axios";

const url = "https://good.example/";

/** @perm net(good.example) */
export async function options() {
  await axios({ url });
  await axios({ url: "https://good.example/", method: "POST", headers: { a: "b" } });
}

/** @perm net(good.example) */
export async function quotedKey() {
  await axios({ "url": "https://good.example/", method: "GET" });
}
