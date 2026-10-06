// Hand-written types for legacy.js. PermLang checks TypeScript, so what legacy.js does
// can't be known: calling into it is unverifiable.
export declare function run(cmd: string): string;
export declare class Legacy {
  constructor(path: string);
  sync(): void;
  get status(): string;
}
export declare const helpers: { purge(): void };
