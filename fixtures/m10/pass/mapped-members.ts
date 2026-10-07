// A member of a mapped type has no declaration of its own, so a function it holds, passed
// along as a value, is judged by its type's signatures (an extended Prisma client's
// operations are such members). A function of the project's own reaches nothing by that.
type Handlers = { [K in "double" | "half"]: (x: number) => number };
const handlers: Handlers = { double: (x) => x * 2, half: (x) => x / 2 };

export function mapped(values: number[]) {
  return values.map(handlers.double);
}
