/** @perm env(PORT) */
export function read(name: string) {
  return process.env[name]; // expect: error PERM001 env
}

/** @perm env(PORT) */
export function leakAll() {
  return Object.keys(process.env); // expect: error PERM001 env
}

/** @perm env(PORT) */
export function rest() {
  const { PORT, ...others } = process.env; // expect: error PERM001 env
  return { PORT, others };
}

/** @perm env(PORT) */
export function computedKey(name: string) {
  const { [name]: value } = process.env; // expect: error PERM001 env
  return value;
}
