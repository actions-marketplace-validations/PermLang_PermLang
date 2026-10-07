import { Database } from "sqlite3";

const db = new Database("app.db");

// sqlite3's Database takes SQL text in run(), all(), get(), and exec(); a prepared
// Statement's methods of the same names run what prepare() read.
/** @perm db.read(leads) */
export function sqlite3Client(id: number) {
  db.all("SELECT * FROM leads WHERE id = ?", id);
  db.run("DELETE FROM sessions"); // expect: error PERM001 db.write(sessions)
  const statement = db.prepare("SELECT name FROM leads WHERE id = ?");
  statement.bind(id).run().all().get();
  statement.finalize().close();
  db.loadExtension("./evil.so"); // expect: error PERM004 unverifiable
}
