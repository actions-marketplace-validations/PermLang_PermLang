import * as mysql from "mysql2/promise";

// A database client a module's function returns past a cast is `any` too, also through the
// promise it's returned in: the queries run on it can't be read.
/** @perm db.read(users) */
export async function connect() {
  const connection = await (mysql as any).createConnection("mysql://db.example/app"); // expect: error PERM004 unverifiable
  return connection.query("DELETE FROM users");
}

// Without the cast, the query is read as usual.
/** @perm db.read(users) */
export async function typed() {
  const connection = await mysql.createConnection("mysql://db.example/app");
  return connection.query("DELETE FROM users"); // expect: error PERM001 db.write(users)
}
