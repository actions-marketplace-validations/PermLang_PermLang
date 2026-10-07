// What the check runs with is recorded in the lock, like what the code reaches: a pull request
// that loosens permlang.config.json, adds an adapter, or narrows tsconfig.json changes the lock,
// so the check fails until `permlang lock` records it (found in the code review, G2, G5, O5).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeScope, isSetting, isSingleValued, readConfig, readTsConfig, settingPhrase, settingsEntries, SettingsError, type Settings } from "../src/settings.js";
import { removeTemporary } from "./temporary.js";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-settings-"));
  cwd = process.cwd();
  process.chdir(dir);
  // A tsconfig.json must select a file that exists.
  write("src/a.ts", "export {};\n");
});
afterEach(() => {
  process.chdir(cwd);
  removeTemporary(dir);
});

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const settings = (s: Partial<Settings> = {}): Settings => ({
  configFile: path.join(dir, "permlang.config.json"),
  strictness: { value: "development", from: "default" },
  unmapped: { value: "warn", from: "default" },
  tools: { value: "warn", from: "default" },
  flows: [],
  adapters: [],
  scope: { paths: [path.join(dir, "src")], given: true },
  ...s,
});
const entry = (s: Settings, name = "<permlang.config.json>") => settingsEntries(s, dir).find((e) => e.name === name)!;
// The options TypeScript works out from the others, recorded in every tsconfig.json entry.
const COMPUTED = /^tsconfig\.(?:target|module|moduleResolution|moduleDetection|esModuleInterop|allowSyntheticDefaultImports|resolvePackageJsonExports|resolvePackageJsonImports|useDefineForClassFields)\(/;
/** What a tsconfig.json entry records apart from those. */
const chosen = (e: { actual: string[] }) => e.actual.filter((c) => !COMPUTED.test(c));

describe("permlang.config.json", () => {
  it("rejects a setting it doesn't know, naming it", () => {
    write("permlang.config.json", JSON.stringify({ strictness: "sketch", unmaped: "trust" }));
    expect(() => readConfig(undefined)).toThrow(new SettingsError('permlang.config.json: unknown setting "unmaped". Settings: strictness, unmapped, tools, adapters, flows.'));
  });

  it("allows $schema, and a byte-order mark", () => {
    write("permlang.config.json", `\u{feff}${JSON.stringify({ $schema: "https://example.com/schema.json", strictness: "sketch" })}`);
    expect(readConfig(undefined)).toEqual({ file: "permlang.config.json", adapters: [], strictness: "sketch" });
  });

  it("prints an unreadable file's error on one line", () => {
    write("permlang.config.json", '{"a":\n::stop-commands::x');
    expect(() => readConfig(undefined)).toThrow(/^Can't read permlang\.config\.json: [^\n]*$/);
  });
});

describe("the settings entry", () => {
  it("records the files checked and the settings in effect, with where each came from", () => {
    const e = entry(settings({ strictness: { value: "sketch", from: "option" }, unmapped: { value: "trust", from: "config" } }));
    expect(e).toMatchObject({ kind: "config", file: path.join(dir, "permlang.config.json") });
    expect(e.actual).toEqual(["permlang.files(src)", "permlang.strictness(sketch)", "permlang.tools(warn)", "permlang.unmapped(trust)"]);
    expect(e.via).toMatchObject({ "permlang.strictness(sketch)": ["--strictness"], "permlang.unmapped(trust)": ["permlang.config.json"], "permlang.tools(warn)": ["default"] });
  });

  it("records a TypeScript project's path, and flow rules", () => {
    write("tsconfig.json", "{}");
    const flows = [{ from: { name: "env", arg: "STRIPE_KEY" }, to: [{ name: "net", arg: "api.stripe.com" }, { name: "net", arg: "x.example" }] }];
    const e = entry(settings({ scope: { project: "tsconfig.json", found: true }, flows }));
    expect(e.actual).toContain("permlang.project(tsconfig.json)");
    expect(e.actual).toContain("permlang.flow(env(STRIPE_KEY) -> net(api.stripe.com), net(x.example))");
  });

  it("records each adapter by its content, not its line endings or formatting", () => {
    write("adapters/a.json", '{ "permlang": 1, "package": "a", "default": [] }\n');
    const first = entry(settings({ adapters: [{ file: path.join(dir, "adapters", "a.json"), from: "config" }] })).actual.find((c) => c.startsWith("permlang.adapter"));
    expect(first).toMatch(/^permlang\.adapter\(adapters\/a\.json sha256:[0-9a-f]{16}\)$/);
    write("adapters/a.json", '{\r\n  "permlang": 1,\r\n  "package": "a",\r\n  "default": []\r\n}\r\n');
    expect(entry(settings({ adapters: [{ file: path.join(dir, "adapters", "a.json"), from: "config" }] })).actual).toContain(first);
    write("adapters/a.json", '{ "permlang": 1, "package": "a", "default": [], "functions": {} }\n');
    expect(entry(settings({ adapters: [{ file: path.join(dir, "adapters", "a.json"), from: "config" }] })).actual).not.toContain(first);
  });
});

describe("the tsconfig.json entry", () => {
  const project = (s: Partial<Settings> = {}) => entry(settings({ scope: { project: "tsconfig.json", found: false }, ...s }), "<tsconfig.json>");

  it("records include, exclude, and files, following extends", () => {
    write("config/base.json", JSON.stringify({ include: ["../src", "../lib/"], exclude: ["../src/legacy"] }));
    write("tsconfig.json", JSON.stringify({ extends: "./config/base.json", files: ["./types.d.ts"] }));
    write("types.d.ts", "export {};\n");
    expect(chosen(project())).toEqual(["tsconfig.exclude(src/legacy)", "tsconfig.files(types.d.ts)", "tsconfig.include(lib)", "tsconfig.include(src)"]);
  });

  it("records the defaults: everything included, and the output folder excluded", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "dist" } }));
    expect(chosen(project())).toEqual(["tsconfig.exclude(dist)", "tsconfig.include(**/*)"]);
    expect(project().via["tsconfig.include(**/*)"]).toEqual(["default"]);
  });

  it("records the options that decide what imports and globals resolve to", () => {
    write("tsconfig.json", JSON.stringify({ include: ["src"], compilerOptions: { baseUrl: ".", paths: { "node:child_process": ["./stub.d.ts"] }, types: [], allowJs: true, lib: ["es2022"] } }));
    expect(chosen(project())).toEqual([
      "tsconfig.allowJs(true)",
      "tsconfig.baseUrl(.)",
      "tsconfig.include(src)",
      "tsconfig.lib(es2022)",
      "tsconfig.paths(node:child_process -> stub.d.ts)",
      "tsconfig.types(none)",
    ]);
  });

  it("refuses a malformed tsconfig.json, or one that extends a file that isn't there", () => {
    write("tsconfig.json", '{ "include": ["src" ');
    expect(() => readTsConfig("tsconfig.json")).toThrow(/^tsconfig\.json: .*expected/);
    write("tsconfig.json", JSON.stringify({ extends: "./missing.json" }));
    expect(() => readTsConfig("tsconfig.json")).toThrow(/^tsconfig\.json: Cannot read file/);
    expect(() => readTsConfig("nope.json")).toThrow("nope.json doesn't exist.");
    expect(() => readTsConfig(".")).toThrow(". isn't a file.");
  });
});

describe("reading settings back", () => {
  it("tells settings from what workflows grant, and describes them", () => {
    expect(isSetting("permlang.unmapped(trust)")).toBe(true);
    expect(isSetting("tsconfig.include(src)")).toBe(true);
    expect(isSetting("ci.secret(NPM_TOKEN)")).toBe(false);
    expect(settingPhrase("permlang.unmapped(trust)")).toBe("unmapped: trust");
    expect(settingPhrase("permlang.strictness(sketch)")).toBe("strictness sketch");
    expect(settingPhrase("permlang.adapter(a.json sha256:0123456789abcdef)")).toBe("the adapter a.json (sha256:0123456789abcdef)");
    expect(settingPhrase("tsconfig.exclude(src/hidden.ts)")).toBe("exclude src/hidden.ts");
    expect(describeScope(["permlang.project(tsconfig.json)"])).toBe("--project tsconfig.json");
    expect(describeScope(["permlang.files(lib)", "permlang.files(src)"])).toBe("lib src");
    expect(describeScope([])).toBe("files it doesn't record");
  });
});

describe("more settings", () => {
  const project = (s: Partial<Settings> = {}) => entry(settings({ scope: { project: "tsconfig.json", found: false }, ...s }), "<tsconfig.json>");

  it("records where the default paths and an --adapter came from", () => {
    write("adapters/b.json", "not json\r\nat all\r\n");
    const e = entry(settings({ scope: { paths: [path.join(dir, "src"), path.join(dir, "src", "")], given: false }, adapters: [{ file: path.join(dir, "adapters", "b.json"), from: "option" }] }));
    expect(e.via["permlang.files(src)"]).toEqual(["default"]);
    const adapter = e.actual.find((c) => c.startsWith("permlang.adapter"))!;
    expect(e.via[adapter]).toEqual(["--adapter"]);
    // A file that isn't JSON is hashed as text, with line endings evened out.
    write("adapters/b.json", "not json\nat all\n");
    expect(entry(settings({ adapters: [{ file: path.join(dir, "adapters", "b.json"), from: "option" }] })).actual).toContain(adapter);
  });

  it("records an empty list, each entry once, and entries that aren't strings as written", () => {
    write("tsconfig.json", JSON.stringify({ include: [], files: ["a.ts", "./a.ts", 5] }));
    write("a.ts", "export {};\n");
    write("5", "export {};\n");
    expect(chosen(project())).toEqual(["tsconfig.files(5)", "tsconfig.files(a.ts)", "tsconfig.include(none)"]);
  });

  it("records the other options that decide what resolves", () => {
    write(
      "tsconfig.json",
      JSON.stringify({
        include: ["src"],
        compilerOptions: {
          paths: { "@app/*": ["./src/*", "./lib/*"] },
          rootDirs: ["src", "generated"],
          typeRoots: ["./types"],
          types: ["node"],
          noLib: true,
          moduleResolution: "bundler",
          customConditions: ["worker"],
          moduleSuffixes: [".ios", ""],
        },
      }),
    );
    expect(chosen(project())).toEqual([
      "tsconfig.customConditions(worker)",
      "tsconfig.include(src)",
      "tsconfig.moduleSuffixes(.ios)",
      "tsconfig.moduleSuffixes(none)",
      "tsconfig.noLib(true)",
      "tsconfig.paths(@app/* -> src/*, lib/*)",
      "tsconfig.rootDirs(generated)",
      "tsconfig.rootDirs(src)",
      "tsconfig.typeRoots(types)",
      "tsconfig.types(node)",
    ]);
    expect(project().actual).toContain("tsconfig.moduleResolution(Bundler)");
  });

  it("records the options TypeScript works out from the others, as it works them out", () => {
    write("tsconfig.json", "{}");
    const defaults = project();
    expect(defaults.actual.filter((c) => COMPUTED.test(c))).toEqual([
      "tsconfig.allowSyntheticDefaultImports(false)",
      "tsconfig.esModuleInterop(false)",
      "tsconfig.module(CommonJS)",
      "tsconfig.moduleDetection(Auto)",
      "tsconfig.moduleResolution(Node10)",
      "tsconfig.resolvePackageJsonExports(false)",
      "tsconfig.resolvePackageJsonImports(false)",
      "tsconfig.target(ES5)",
      "tsconfig.useDefineForClassFields(false)",
    ]);
    expect(defaults.via["tsconfig.module(CommonJS)"]).toEqual(["default"]);
    // `module` alone decides the rest.
    write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "nodenext" } }));
    const node = project();
    expect(node.actual.filter((c) => COMPUTED.test(c))).toEqual([
      "tsconfig.allowSyntheticDefaultImports(true)",
      "tsconfig.esModuleInterop(true)",
      "tsconfig.module(NodeNext)",
      "tsconfig.moduleDetection(Force)",
      "tsconfig.moduleResolution(NodeNext)",
      "tsconfig.resolvePackageJsonExports(true)",
      "tsconfig.resolvePackageJsonImports(true)",
      "tsconfig.target(ESNext)",
      "tsconfig.useDefineForClassFields(true)",
    ]);
    expect(node.via["tsconfig.module(NodeNext)"]).toEqual(["tsconfig.json"]);
    expect(node.via["tsconfig.esModuleInterop(true)"]).toEqual(["default"]);
  });

  it("records the options that are off unless set, once they're set", () => {
    write("tsconfig.json", "{}");
    expect(chosen(project())).toEqual(["tsconfig.include(**/*)"]);
    const options = {
      checkJs: true,
      preserveSymlinks: true,
      allowArbitraryExtensions: true,
      libReplacement: false,
      importHelpers: true,
      jsx: "react",
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      reactNamespace: "R",
      noResolve: true,
    };
    write("tsconfig.json", JSON.stringify({ compilerOptions: options }));
    expect(chosen(project())).toEqual([
      "tsconfig.allowArbitraryExtensions(true)",
      "tsconfig.allowJs(true)",
      "tsconfig.importHelpers(true)",
      "tsconfig.include(**/*)",
      "tsconfig.jsx(react)",
      "tsconfig.jsxFactory(h)",
      "tsconfig.jsxFragmentFactory(Fragment)",
      "tsconfig.libReplacement(false)",
      "tsconfig.preserveSymlinks(true)",
      "tsconfig.reactNamespace(R)",
    ]);
    write("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react-jsxdev", jsxImportSource: "preact" } }));
    expect(chosen(project())).toEqual(["tsconfig.include(**/*)", "tsconfig.jsx(react-jsxdev)", "tsconfig.jsxImportSource(preact)"]);
  });

  it("records each value of jsx as tsconfig.json spells it", () => {
    for (const jsx of ["preserve", "react", "react-native", "react-jsx", "react-jsxdev"]) {
      write("tsconfig.json", JSON.stringify({ compilerOptions: { jsx } }));
      expect(chosen(project())).toContain(`tsconfig.jsx(${jsx})`);
    }
  });

  it("records every target, module, and moduleResolution by its name", () => {
    const recorded = (compilerOptions: Record<string, string>) => {
      write("tsconfig.json", JSON.stringify({ compilerOptions }));
      return project().actual.filter((c) => /^tsconfig\.(target|module|moduleResolution|moduleDetection)\(/.test(c));
    };
    expect(recorded({ target: "esnext", module: "preserve", moduleResolution: "bundler", moduleDetection: "legacy" })).toEqual([
      "tsconfig.module(Preserve)",
      "tsconfig.moduleDetection(Legacy)",
      "tsconfig.moduleResolution(Bundler)",
      "tsconfig.target(ESNext)",
    ]);
    expect(recorded({ target: "es2015", module: "node16" })).toEqual([
      "tsconfig.module(Node16)",
      "tsconfig.moduleDetection(Force)",
      "tsconfig.moduleResolution(Node16)",
      "tsconfig.target(ES2015)",
    ]);
  });

  it("pairs an old and a new value for each option that holds one", () => {
    expect(isSingleValued("tsconfig.allowSyntheticDefaultImports(true)")).toBe(true);
    expect(isSingleValued("tsconfig.jsxImportSource(preact)")).toBe(true);
    expect(isSingleValued("tsconfig.include(src)")).toBe(false);
    expect(isSingleValued("tsconfig.types(node)")).toBe(false);
    expect(isSingleValued("permlang.strictness(sketch)")).toBe(true);
    expect(isSingleValued("permlang.imported(lib/db.ts)")).toBe(false);
  });

  it("describes flow rules and checked files", () => {
    expect(settingPhrase("permlang.flow(env(K) -> net(x.example))")).toBe("the flow rule env(K) -> net(x.example)");
    expect(settingPhrase("permlang.project(tsconfig.json)")).toBe("the files of tsconfig.json");
    expect(settingPhrase("permlang.files(src)")).toBe("the files under src");
    expect(settingPhrase("permlang.imported(lib/db.ts)")).toBe("lib/db.ts (imported by the checked files)");
    expect(settingPhrase("tsconfig.include(src)")).toBe("include src");
  });

  it("records the files read because the checked ones import them, apart from the scope", () => {
    const e = settingsEntries(settings(), dir, [path.join(dir, "lib", "db.ts"), path.join(dir, "..", "shared", "x.ts")])[0]!;
    expect(e.actual.filter((c) => c.startsWith("permlang.imported"))).toEqual(["permlang.imported(../shared/x.ts)", "permlang.imported(lib/db.ts)"]);
    expect(e.via["permlang.imported(lib/db.ts)"]).toEqual(["imported"]);
    expect(isSetting("permlang.imported(lib/db.ts)")).toBe(true);
  });
});
