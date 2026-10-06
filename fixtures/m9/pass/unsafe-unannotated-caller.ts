// @perm-unsafe vouches for code that can't be analyzed, so even a caller with no @perm
// isn't failed for it.
/** @perm-unsafe reason:"template compiler; input is trusted build-time templates" */
function compile(template: string) {
  return new Function("data", template);
}

export function page() {
  return compile("return data.title");
}
