import { Router } from "express";
import { z } from "zod";
import { prisma } from "../PrismaClient.js";
import { requireAdmin } from "../auth.js";
import { areas, areaKeys, date } from "../core/schemas.js";
import { dbDate, fail, sha } from "../core/http.js";
export const taskImportInput = z.object({
  source: z.literal("notion"),
  startDate: date,
  rows: z
    .array(
      z.object({
        sourceId: z.string().uuid(),
        name: z.string().trim().min(1).max(120),
        area: z.enum(areas),
        periodDays: z.number().int().min(1).max(36500).nullable(),
        weightHours: z.number().finite().min(0).max(10000).nullable(),
      }),
    )
    .min(1)
    .max(1000),
});
type Input = z.infer<typeof taskImportInput>;
const key = (id: string) => "notion-task:" + id;
async function preview(body: Input) {
  if (new Set(body.rows.map((row) => row.sourceId)).size !== body.rows.length)
    fail(400, "IDs de origem repetidos.");
  const sources = await prisma.importSource.findMany({
    where: { key: { in: body.rows.map((row) => key(row.sourceId)) } },
  });
  const existing = new Map(
    sources.map((source) => [source.key, source.checksum]),
  );
  const conflicts = body.rows
    .filter(
      (row) =>
        existing.has(key(row.sourceId)) &&
        existing.get(key(row.sourceId)) !== sha(JSON.stringify(row)),
    )
    .map((row) => row.sourceId);
  return {
    startDate: body.startDate,
    total: body.rows.length,
    recurring: body.rows.filter((row) => row.periodDays !== null).length,
    exceptional: body.rows.filter((row) => row.periodDays === null).length,
    missingWeights: body.rows.filter((row) => row.weightHours === null).length,
    alreadyImported: sources.length,
    toCreate: body.rows.length - sources.length,
    conflicts,
  };
}
export const taskImportsRouter = Router();
taskImportsRouter.use((_req, res, next) => {
  requireAdmin(res.locals.actor);
  next();
});
taskImportsRouter.post("/preview", async (req, res) =>
  res.json(await preview(taskImportInput.parse(req.body))),
);
taskImportsRouter.post("/commit", async (req, res) => {
  const body = taskImportInput.parse(req.body),
    actor = requireAdmin(res.locals.actor);
  const check = await preview(body);
  if (check.conflicts.length)
    fail(
      409,
      "A origem contém tarefas alteradas já importadas. Revise os conflitos antes de continuar.",
    );
  const result = await prisma.$transaction(
    async (tx) => {
      // Serialize catalog imports so simultaneous retries cannot create duplicate tasks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(817264)`;
      let created = 0,
        skipped = 0;
      for (const row of body.rows) {
        const checksum = sha(JSON.stringify(row));
        const source = await tx.importSource.findUnique({
          where: { key: key(row.sourceId) },
        });
        if (source) {
          if (source.checksum !== checksum)
            fail(409, "Tarefa de origem já importada com outros dados.");
          skipped++;
          continue;
        }
        const recurrence =
          row.periodDays === null
            ? { kind: "once" }
            : {
                kind: "interval",
                everyDays: row.periodDays,
                anchorDate: body.startDate,
              };
        const task = await tx.task.create({
          data: {
            name: row.name,
            area: areaKeys[areas.indexOf(row.area)],
            weightHours: row.weightHours,
            recurrence,
            dueDate: dbDate(body.startDate),
            assigneeId: null,
          },
        });
        await tx.taskEvent.create({
          data: {
            taskId: task.id,
            actorId: actor.id,
            kind: "imported",
            data: {
              source: "notion",
              sourceId: row.sourceId,
              periodDays: row.periodDays,
              weightHours: row.weightHours,
              startDate: body.startDate,
            },
          },
        });
        await tx.importSource.create({
          data: { key: key(row.sourceId), checksum },
        });
        created++;
      }
      return { created, skipped };
    },
    { timeout: 60000 },
  );
  res.status(result.created ? 201 : 200).json(result);
});
