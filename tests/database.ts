import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
export default async function setup(project: any) {
  const directory = mkdtempSync(join(tmpdir(), "reprgb-test-"));
  const pg = new EmbeddedPostgres({
    databaseDir: directory,
    user: "postgres",
    password: "reprgb-test",
    port: 55439,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("reprgb_test");
  const url = "postgresql://postgres:reprgb-test@127.0.0.1:55439/reprgb_test";
  project.provide("databaseUrl", url);
  try {
    execFileSync(
      "node",
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  } catch (e) {
    await pg.stop();
    throw e;
  }
  return async () => {
    await pg.stop();
  };
}
