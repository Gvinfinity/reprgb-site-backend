import type { PrismaClient } from "../generated/client.js";
import { sha } from "./http.js";
export const backupTables = [
  "people",
  "leaderboards",
  "User",
  "Session",
  "Account",
  "Verification",
  "Invitation",
  "Task",
  "TaskCompletion",
  "TaskEvent",
  "Quote",
  "QuoteImport",
  "Movie",
  "Screening",
  "DataImport",
  "ImportSource",
] as const;
export async function backupDatabase(db: PrismaClient) {
  const tables = await db.$transaction(
    async (tx) => {
      const result: Record<string, unknown[]> = {};
      for (const table of backupTables) {
        const rows = await tx.$queryRawUnsafe<{ row: unknown }[]>(
          `SELECT row_to_json(t) AS row FROM "${table}" t`,
        );
        result[table] = rows.map((r) => r.row);
      }
      return result;
    },
    { isolationLevel: "RepeatableRead", timeout: 60000 },
  );
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    checksum: sha(JSON.stringify(tables)),
    tables,
  };
}
export async function restoreDatabase(
  db: PrismaClient,
  backup: {
    version: number;
    checksum: string;
    tables: Record<string, unknown[]>;
  },
) {
  if (
    backup.version !== 1 ||
    backup.checksum !== sha(JSON.stringify(backup.tables)) ||
    backupTables.some((table) => !Array.isArray(backup.tables[table]))
  )
    throw new Error("Backup inválido.");
  await db.$transaction(
    async (tx) => {
      for (const table of backupTables) {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "${table}"`,
        );
        if (Number(rows[0].n) !== 0)
          throw new Error(
            "A restauração exige um banco vazio, com migrações aplicadas.",
          );
      }
      for (const table of backupTables)
        for (const row of backup.tables[table])
          await tx.$executeRawUnsafe(
            `INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`,
            JSON.stringify(row),
          );
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('leaderboards','id'),COALESCE((SELECT MAX(id) FROM leaderboards),1),(SELECT COUNT(*)>0 FROM leaderboards))`,
      );
    },
    { timeout: 120000 },
  );
}
