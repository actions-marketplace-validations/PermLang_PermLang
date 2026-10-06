// Found in the 0.4 code review: these @perm tags were dropped without a word. Each now
// attaches to the function it describes.

// An object literal's function-valued property.
export const api = {
  /** @perm net(api.example) */
  go: () => fetch("https://api.example/"),
};

// A class with no constructor: field initializers run in its implicit one.
/** @perm net(field.example) */
export class Preloaded {
  data = fetch("https://field.example/");
}

// The same, for a class expression held by a variable.
/** @perm net(expr.example) */
export const Lazy = class {
  data = fetch("https://expr.example/");
};

// A default-exported arrow function.
/** @perm net(default.example) */
export default async () => fetch("https://default.example/");
