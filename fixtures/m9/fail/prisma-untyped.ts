import { PrismaClient } from "@prisma/client";
import { extendedClient } from "@prisma/client/extension";

const prisma = new PrismaClient();
const ext = extendedClient();

// Typings without Prisma's payload types (Prisma 4, hand-written stand-ins) don't say
// which keys are relations, so anything that could name one could reach any table.
/** @perm db.read(lead) */
export async function withoutRelations(id: string) {
  await prisma.lead.findMany({ where: { id } });
  await prisma.lead.findMany({ include: { owner: true } }); // expect: error PERM001 db.read
  await prisma.lead.findMany({ where: { name: { contains: "x" } } }); // expect: error PERM001 db.read
}

// An extended client reached other than as client.model names no model.
/** @perm db.read(user) */
export async function unnamed(id: string) {
  const users = ext.user;
  await users.findMany(); // expect: error PERM001 db.read
  const { findUnique } = ext.user;
  await findUnique({ where: { id } }); // expect: error PERM001 db.read
}
