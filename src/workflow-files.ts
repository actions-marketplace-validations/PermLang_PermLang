// GitHub workflows and Actions: what each file grants, read where GitHub reads it.
// Triggers, token permissions, Actions (`uses:` on steps and on jobs that call a
// reusable workflow), container images, and `secrets: inherit` are read from their
// places in the file, through aliases. Secrets are read from every `${{ }}` expression,
// keys included, and from `if:` conditions, which are expressions without `${{ }}`.

import { isMap, isScalar, isSeq, visit } from "yaml";
import { expressionsIn, literalOf, secretsRead } from "./ci-expressions.js";
import type { Sink } from "./project-files.js";
import { YamlFile, type Position, type Value } from "./yaml-nodes.js";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A step's `uses: ./path`: an Action elsewhere in the repository, which the caller reads too. */
export interface LocalAction {
  ref: string;
  at: Position;
}

/** Records what a workflow or Action file grants, and returns the local Actions its steps run. */
export function readWorkflowFile(text: string, kind: "workflow" | "action", sink: Sink): LocalAction[] {
  const yaml = new YamlFile(text);
  // A file GitHub reads but PermLang can't: recorded, so it can't hide anything.
  if (!yaml.readable) {
    sink.unverifiable("a YAML file PermLang can't read", { line: 1, column: 1 });
    return [];
  }
  for (const problem of yaml.problems) sink.unverifiable(`an alias PermLang can't follow: ${problem.why}`, problem.at);
  const reader = new Reader(yaml, sink);
  reader.secrets();
  if (kind === "workflow") reader.workflow();
  else reader.action();
  return reader.local;
}

class Reader {
  readonly local: LocalAction[] = [];
  constructor(
    private readonly yaml: YamlFile,
    private readonly sink: Sink,
  ) {}

  workflow() {
    const root = this.yaml.root();
    const triggers = this.yaml.get(root, "on");
    const allJobs = this.yaml.get(root, "jobs");
    // GitHub needs both. A workflow that seems to lack one may read differently to GitHub (stray
    // byte-order marks or invisible characters in a key), so it's recorded rather than trusted.
    if (triggers.length === 0 || allJobs.length === 0) this.sink.unverifiable("a workflow without both on: and jobs:", { line: 1, column: 1 });
    for (const on of triggers) this.triggers(on);
    const workflowPermissions = this.yaml.get(root, "permissions");
    for (const jobs of allJobs) {
      for (const job of this.yaml.fields(jobs)) if (isMap(job.value.node)) this.job(job.value, workflowPermissions, job.at);
    }
  }

  action() {
    for (const runs of this.yaml.get(this.yaml.root(), "runs")) {
      for (const steps of this.yaml.get(runs, "steps")) this.steps(steps);
      // A Docker Action's image; one built from a Dockerfile in the Action is part of the repository.
      for (const image of this.yaml.get(runs, "image")) {
        const ref = this.yaml.text(image.node)?.trim();
        if (ref?.startsWith("docker://")) this.image(ref, `image: ${ref}`, image.at);
      }
      for (const key of ["pre-if", "post-if"]) for (const condition of this.yaml.get(runs, key)) this.condition(condition);
    }
  }

  /** Every secret any expression reads, wherever it is: GitHub evaluates them in keys as well as values. */
  secrets() {
    visit(this.yaml.doc, {
      Scalar: (_, node) => {
        if (typeof node.value !== "string" || !node.value.includes("${{")) return;
        for (const expression of expressionsIn(node.value)) {
          for (const name of secretsRead(expression)) this.add(`ci.secret(${name})`, expression.trim(), this.yaml.position(node));
        }
      },
    });
  }

  private triggers(on: Value) {
    const one = this.yaml.text(on.node);
    if (one) this.add(`ci.trigger(${one})`, `on: ${one}`, on.at);
    for (const item of this.yaml.items(on)) {
      const event = this.yaml.text(item.node);
      if (event) this.add(`ci.trigger(${event})`, `on: ${event}`, item.at);
    }
    for (const event of this.yaml.fields(on)) this.add(`ci.trigger(${event.key})`, `on: ${event.key}`, event.at);
  }

  private job(job: Value, workflowPermissions: Value[], at: Position) {
    const own = this.yaml.get(job, "permissions");
    this.permissions(own.length > 0 ? own : workflowPermissions, at);
    for (const condition of this.yaml.get(job, "if")) this.condition(condition);
    for (const uses of this.yaml.get(job, "uses")) this.uses(uses, false);
    for (const secrets of this.yaml.get(job, "secrets")) {
      if (this.yaml.text(secrets.node)?.toLowerCase() === "inherit") this.add("ci.secret(inherit)", "secrets: inherit", secrets.at);
    }
    for (const steps of this.yaml.get(job, "steps")) this.steps(steps);
    for (const container of this.yaml.get(job, "container")) this.container(container, "container");
    for (const services of this.yaml.get(job, "services")) {
      if (this.yaml.text(services.node)?.includes("${{")) this.sink.unverifiable("services: from an expression, so PermLang can't tell which images", services.at);
      for (const service of this.yaml.fields(services)) {
        if (service.key.includes("${{")) this.sink.unverifiable(`services: ${service.key}: an expression PermLang can't read`, service.at);
        else this.container(service.value, `services: ${service.key}`);
      }
    }
  }

  /** A job's token permissions: its own block, else the workflow's, else the repository default. */
  private permissions(blocks: Value[], at: Position) {
    if (blocks.length === 0) {
      this.add("ci.permission(default)", "no permissions block: the token gets the repository's default, which can be write-all", at);
      return;
    }
    for (const block of blocks) {
      const shorthand = this.yaml.text(block.node);
      // `permissions:` with no value isn't `{}`: GitHub rejects it, and read as no block it would mean the default.
      if (shorthand === "") this.add("ci.permission(default)", "permissions: with no value, so the token gets the repository's default", block.at);
      else if (shorthand !== undefined) this.add(`ci.permission(${shorthand})`, `permissions: ${shorthand}`, block.at);
      else if (!isMap(block.node)) this.sink.unverifiable("a permissions block PermLang can't read", block.at);
      for (const scope of this.yaml.fields(block)) {
        const level = this.yaml.text(scope.value.node);
        if (level) this.add(`ci.permission(${scope.key}: ${level})`, `permissions: ${scope.key}: ${level}`, scope.at);
        else this.sink.unverifiable(`permissions: ${scope.key} has no level PermLang can read`, scope.at);
      }
    }
  }

  /** Steps' Actions and conditions, including steps grouped under `parallel:`. */
  private steps(steps: Value, seen = new Set<unknown>()) {
    if (!isSeq(steps.node) || seen.has(steps.node)) return;
    seen.add(steps.node);
    for (const step of this.yaml.items(steps)) {
      for (const uses of this.yaml.get(step, "uses")) this.uses(uses, true);
      for (const condition of this.yaml.get(step, "if")) this.condition(condition);
      for (const group of this.yaml.get(step, "parallel")) this.steps(group, seen);
    }
  }

  /** `owner/repo/path@ref`, `./local`, or `docker://image`. A step's local Action is read too. */
  private uses(value: Value, step: boolean) {
    const uses = this.yaml.text(value.node)?.trim();
    if (!uses) return;
    const text = `uses: ${uses}`;
    if (uses.startsWith("docker://")) return this.image(uses, text, value.at);
    if (uses.startsWith("./") || uses.startsWith(".\\") || uses.startsWith("$/")) {
      this.add(`ci.action(${uses})`, text, value.at);
      // `$/path` is the repository's own Action, but it isn't documented which commit it runs.
      if (uses.startsWith("$/")) this.add(`ci.unpinned(${uses})`, text, value.at);
      if (step) this.local.push({ ref: uses, at: value.at });
      return;
    }
    const at = uses.lastIndexOf("@");
    const name = at === -1 ? uses : uses.slice(0, at);
    this.add(`ci.action(${name})`, text, value.at);
    if (at === -1 || !SHA.test(uses.slice(at + 1))) this.add(`ci.unpinned(${name})`, text, value.at);
  }

  /** A job's `container:` or a service: an image, written alone or as `image:`. */
  private container(container: Value, label: string) {
    const image = this.yaml.text(container.node)?.trim();
    if (image) this.image(image, `${label}: ${image}`, container.at);
    for (const field of this.yaml.fields(container)) {
      if (field.key.includes("${{")) this.sink.unverifiable(`${label}: ${field.key}: an expression PermLang can't read`, field.at);
      if (field.key !== "image") continue;
      const ref = this.yaml.text(field.value.node)?.trim();
      if (ref) this.image(ref, `${label}: image: ${ref}`, field.value.at);
    }
  }

  /** A container image, recorded by its full name (registry, port, and path) and pinned only by a digest. */
  private image(ref: string, text: string, at: Position) {
    const image = dockerImage(ref.replace(/^docker:\/\//, ""));
    if (!image) return this.sink.unverifiable(`${text}: an image PermLang can't name`, at);
    this.add(`ci.action(docker://${image.name})`, text, at);
    if (!image.pinned) this.add(`ci.unpinned(docker://${image.name})`, text, at);
  }

  /** An `if:` is an expression even without `${{ }}`; those with it are read with every other expression. */
  private condition(value: Value) {
    if (!isScalar(value.node) || typeof value.node.value !== "string") return;
    const condition = literalOf(value.node.value);
    if (condition.includes("${{")) return;
    for (const name of secretsRead(condition)) this.add(`ci.secret(${name})`, `if: ${condition.trim()}`, value.at);
  }

  private add(capability: string, text: string, at: Position) {
    this.sink.add(capability, text, at);
  }
}

/**
 * `[registry[:port]/]path[:tag][@digest]` → the image's name (everything but the tag and
 * digest) and whether a sha256 digest pins it. Undefined when an expression is part of
 * the name, so which image runs can't be known.
 */
export function dockerImage(ref: string): { name: string; pinned: boolean } | undefined {
  const at = ref.indexOf("@");
  const nameAndTag = at === -1 ? ref : ref.slice(0, at);
  // A colon after the last slash starts the tag; one before it is a registry's port.
  const colon = nameAndTag.lastIndexOf(":");
  const name = colon > nameAndTag.lastIndexOf("/") ? nameAndTag.slice(0, colon) : nameAndTag;
  if (name === "" || name.includes("${{")) return undefined;
  return { name, pinned: at !== -1 && DIGEST.test(ref.slice(at + 1)) };
}
