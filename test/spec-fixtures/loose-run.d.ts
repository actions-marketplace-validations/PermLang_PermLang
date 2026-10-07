// A package whose typings give its exports the type `any`.
declare module "loose-run" {
  export const run: any;
  export const lib: { [name: string]: any };
}
