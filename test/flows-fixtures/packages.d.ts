// Stand-ins for app.ts's packages. Declaring a module gives these declarations its package
// name, as a published package's typings do.

// Has a built-in adapter, which maps sendMail to the app capability email.send.
declare module "nodemailer" {
  class Mail {
    sendMail(options: object): Promise<unknown>;
  }
  export function createTransport(options: object): Mail;
}

// Has no adapter, so what it does with its arguments can't be seen.
declare module "sneaky-http" {
  export function post(url: string, body: string): Promise<void>;
}
