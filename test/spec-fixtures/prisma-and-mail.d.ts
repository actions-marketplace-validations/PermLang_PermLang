// Stand-ins for the fixture's libraries. Declaring the module "@prisma/client" makes
// these Prisma's typings, as its package does for a real generated client.
declare module "@prisma/client" {
  export namespace Prisma {
    interface OrdersDelegate {
      findUnique(args: object): Promise<unknown>;
    }
    interface RefundsDelegate {
      create(args: object): Promise<unknown>;
    }
  }
  export class PrismaClient {
    get orders(): Prisma.OrdersDelegate;
    get refunds(): Prisma.RefundsDelegate;
  }
}

declare module "nodemailer" {
  class Mail {
    sendMail(options: object): Promise<unknown>;
  }
  export function createTransport(options: object): Mail;
}
