import { Router } from "express";
import { z } from "zod";
import { prisma } from "../PrismaClient.js";
import { requireAdmin } from "../auth.js";
import {
  taskInput,
  quoteInput,
  screeningInput,
  date,
  minutes,
  recurrence,
  areas,
  areaKeys,
} from "../core/schemas.js";
import { dbDate, sha, fail } from "../core/http.js";
const oldId = z.string().min(1).max(150);
const completion = z.object({
  id: oldId,
  scheduledDate: date,
  completedAt: z.iso.datetime({ offset: true }),
  residentId: oldId,
  durationMinutes: minutes,
});
const task = z.object({
  id: oldId,
  name: z.string(),
  weightHours: z
    .number()
    .finite()
    .nonnegative()
    .max(10000)
    .nullable()
    .optional(),
  area: z.enum(areas),
  assigneeId: oldId.nullable(),
  recurrence: recurrence,
  dueDate: date,
  status: z.enum(["pending", "completed", "archived"]),
  completions: z.array(completion).max(10000),
});
const snapshot = z.object({
  version: z.literal(3),
  tasks: z.array(task).max(1000),
  quotes: z.array(quoteInput.extend({ id: oldId })).max(10000),
  screenings: z.array(screeningInput.safeExtend({ id: oldId })).max(1000),
});
const input = z.object({
  snapshot,
  mapping: z.record(z.string(), z.string().uuid()),
});
export const importsRouter = Router();
importsRouter.use((_req, res, next) => {
  requireAdmin(res.locals.actor);
  next();
});
async function preview(body: z.infer<typeof input>) {
  const people = await prisma.person.findMany({ select: { id: true } });
  const valid = new Set(people.map((p) => p.id));
  const required = [
    ...new Set(
      body.snapshot.tasks.flatMap((t) => [
        ...(t.assigneeId ? [t.assigneeId] : []),
        ...t.completions.map((c) => c.residentId),
      ]),
    ),
  ];
  const missing = required.filter(
    (id) => !body.mapping[id] || !valid.has(body.mapping[id]),
  );
  const keys = [
    ...body.snapshot.tasks.map((t) => "task:" + t.id),
    ...body.snapshot.quotes.map((q) => "quote:" + q.id),
    ...body.snapshot.screenings.map((s) => "screening:" + s.id),
  ];
  if (new Set(keys).size !== keys.length)
    fail(400, "IDs repetidos no arquivo.");
  const conflicts = await prisma.importSource.findMany({
    where: { key: { in: keys } },
  });
  return {
    required,
    missing,
    conflicts: conflicts.map((c) => c.key),
    counts: {
      tasks: body.snapshot.tasks.length,
      completions: body.snapshot.tasks.reduce(
        (n, t) => n + t.completions.length,
        0,
      ),
      quotes: body.snapshot.quotes.length,
      screenings: body.snapshot.screenings.length,
    },
  };
}
importsRouter.post("/preview", async (req, res) => {
  const body = input.parse(req.body);
  res.json(await preview(body));
});
importsRouter.post("/commit", async (req, res) => {
  const body = input.parse(req.body),
    actor = requireAdmin(res.locals.actor),
    checksum = sha(JSON.stringify(body));
  const existing = await prisma.dataImport.findUnique({ where: { checksum } });
  if (existing) {
    res.json(existing.result);
    return;
  }
  const check = await preview(body);
  if (check.missing.length || check.conflicts.length)
    fail(
      409,
      "Resolva os moradores não mapeados e os registros já importados.",
    );
  const result = await prisma.$transaction(
    async (tx) => {
      for (const t of body.snapshot.tasks) {
        const validated = taskInput.parse({
          ...t,
          assigneeId: t.assigneeId ? body.mapping[t.assigneeId] : null,
        });
        if (t.status === "completed" && t.recurrence.kind !== "once")
          fail(400, "Estado de tarefa inválido.");
        const created = await tx.task.create({
          data: {
            name: validated.name,
            weightHours: t.weightHours ?? null,
            area: areaKeys[areas.indexOf(t.area)],
            assigneeId: validated.assigneeId,
            recurrence: t.recurrence,
            dueDate: dbDate(t.dueDate),
            status: t.status,
          },
        });
        for (const c of t.completions)
          await tx.taskCompletion.create({
            data: {
              taskId: created.id,
              scheduledDate: dbDate(c.scheduledDate),
              completedAt: new Date(c.completedAt),
              residentId: body.mapping[c.residentId],
              durationMinutes: c.durationMinutes,
              taskSnapshot: {
                name: t.name,
                area: t.area,
                recurrence: t.recurrence,
              },
              actorId: actor.id,
              idempotencyKey: "import:" + sha("task:" + t.id + ":" + c.id),
              requestHash: sha(JSON.stringify(c)),
            },
          });
        await tx.taskEvent.create({
          data: {
            taskId: created.id,
            actorId: actor.id,
            kind: "imported",
            data: { sourceId: t.id, checksum },
          },
        });
        await tx.importSource.create({
          data: { key: "task:" + t.id, checksum },
        });
      }
      for (const q of body.snapshot.quotes) {
        await tx.quote.create({
          data: {
            text: q.text,
            author: q.author,
            date: q.date ? dbDate(q.date) : null,
          },
        });
        await tx.importSource.create({
          data: { key: "quote:" + q.id, checksum },
        });
      }
      for (const s of body.snapshot.screenings) {
        const movie = await tx.movie.create({
          data: {
            title: s.title,
            year: s.year,
            genre: s.genre,
            duration: s.duration,
            synopsis: s.synopsis,
            posterUrl: s.posterUrl,
          },
        });
        await tx.screening.create({
          data: {
            movieId: movie.id,
            status: s.status,
            scheduledAt: s.scheduledAt ? new Date(s.scheduledAt) : null,
          },
        });
        await tx.importSource.create({
          data: { key: "screening:" + s.id, checksum },
        });
      }
      await tx.dataImport.create({
        data: { checksum, actorId: actor.id, result: check.counts },
      });
      return check.counts;
    },
    { timeout: 60000 },
  );
  res.status(201).json(result);
});
