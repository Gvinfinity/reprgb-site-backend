import { Router } from "express";
import { z } from "zod";
import { prisma } from "../PrismaClient.js";
import { requireAdmin, requireUser, type Actor } from "../auth.js";
import {
  taskInput,
  areas,
  areaKeys,
  minutes,
  version,
  type TaskRecurrence,
} from "../core/schemas.js";
import { dbDate, day, fail, sha } from "../core/http.js";
import { houseDate, nextOccurrence } from "../core/schedule.js";
import type { Prisma, Task, TaskCompletion } from "../generated/client.js";
type Tx = Prisma.TransactionClient;
export function taskDto(task: Task & { completions: TaskCompletion[] }) {
  return {
    ...task,
    area: areas[areaKeys.indexOf(task.area)],
    dueDate: day(task.dueDate),
    completions: task.completions.map((c) => ({
      ...c,
      scheduledDate: day(c.scheduledDate),
      idempotencyKey: undefined,
      requestHash: undefined,
      actorId: undefined,
    })),
  };
}
export const taskInclude = {
  completions: { orderBy: { completedAt: "asc" as const } },
};
async function resident(tx: Tx, id: string | null) {
  if (
    id &&
    !(await tx.person.findFirst({
      where: { id, active: true, isHousemate: true },
    }))
  )
    fail(400, "Morador indisponível.");
}
async function load(tx: Tx, id: string, expected: number, pendingOnly = true) {
  const task = await tx.task.findUnique({ where: { id } });
  if (!task) return fail(404, "Tarefa não encontrada.");
  if (task.version !== expected || (pendingOnly && task.status !== "pending"))
    fail(409, "A tarefa mudou. Atualize o quadro.");
  return task;
}
async function change(
  tx: Tx,
  task: Task,
  data: Prisma.TaskUncheckedUpdateManyInput,
  actor: Actor,
  kind: string,
  event: Prisma.InputJsonValue,
) {
  const result = await tx.task.updateMany({
    where: { id: task.id, version: task.version, status: task.status },
    data: { ...data, version: { increment: 1 } },
  });
  if (!result.count) fail(409, "A tarefa mudou. Atualize o quadro.");
  await tx.taskEvent.create({
    data: { taskId: task.id, actorId: actor.id, kind, data: event },
  });
}
export const tasksRouter = Router();
tasksRouter.get("/", async (_req, res) =>
  res.json(
    (
      await prisma.task.findMany({
        include: taskInclude,
        orderBy: { dueDate: "asc" },
      })
    ).map(taskDto),
  ),
);
tasksRouter.post("/", async (req, res) => {
  const actor = requireAdmin(res.locals.actor);
  const body = taskInput.parse(req.body);
  const task = await prisma.$transaction(async (tx) => {
    await resident(tx, body.assigneeId);
    const t = await tx.task.create({
      data: {
        ...body,
        area: areaKeys[areas.indexOf(body.area)],
        dueDate: dbDate(body.dueDate),
      },
      include: taskInclude,
    });
    await tx.taskEvent.create({
      data: { taskId: t.id, actorId: actor.id, kind: "created", data: body },
    });
    return t;
  });
  res.status(201).json(taskDto(task));
});
tasksRouter.patch("/:id", async (req, res) => {
  const actor = requireAdmin(res.locals.actor);
  const body = taskInput.parse(req.body);
  const expected = version.parse(req.body.version);
  await prisma.$transaction(async (tx) => {
    const task = await load(tx, String(req.params.id), expected);
    await resident(tx, body.assigneeId);
    await change(
      tx,
      task,
      {
        ...body,
        area: areaKeys[areas.indexOf(body.area)],
        dueDate: dbDate(body.dueDate),
      },
      actor,
      "edited",
      {
        before: {
          weightHours: task.weightHours,
          name: task.name,
          recurrence: task.recurrence,
          dueDate: day(task.dueDate),
          assigneeId: task.assigneeId,
        },
        after: body,
      },
    );
  });
  res.json({ ok: true });
});
tasksRouter.post("/:id/archive", async (req, res) => {
  const actor = requireAdmin(res.locals.actor);
  const expected = version.parse(req.body.version);
  await prisma.$transaction(async (tx) => {
    const task = await load(tx, String(req.params.id), expected, false);
    await change(tx, task, { status: "archived" }, actor, "archived", {});
  });
  res.json({ ok: true });
});
tasksRouter.patch("/:id/assignment", async (req, res) => {
  const actor = requireUser(res.locals.actor);
  const body = z
    .object({ version, assigneeId: z.string().uuid().nullable() })
    .parse(req.body);
  await prisma.$transaction(async (tx) => {
    const task = await load(tx, String(req.params.id), body.version);
    if (
      actor.role !== "admin" &&
      !(
        actor.residentId &&
        (body.assigneeId === actor.residentId ||
          (body.assigneeId === null && task.assigneeId === actor.residentId))
      )
    )
      fail(403, "Você só pode assumir tarefas ou devolver as suas.");
    await resident(tx, body.assigneeId);
    await change(
      tx,
      task,
      { assigneeId: body.assigneeId },
      actor,
      body.assigneeId ? "assigned" : "returned",
      { from: task.assigneeId, to: body.assigneeId },
    );
  });
  res.json({ ok: true });
});
tasksRouter.post("/:id/reopen", async (req, res) => {
  const actor = requireUser(res.locals.actor);
  const expected = version.parse(req.body.version);
  await prisma.$transaction(async (tx) => {
    const task = await load(tx, String(req.params.id), expected, false);
    const last = await tx.taskCompletion.findFirst({
      where: { taskId: task.id },
      orderBy: { completedAt: "desc" },
    });
    if (!last || task.status === "archived")
      return fail(409, "Esta tarefa não pode ser reaberta.");
    if (
      actor.role !== "admin" &&
      (last.residentId !== actor.residentId ||
        (task.assigneeId && task.assigneeId !== actor.residentId))
    )
      fail(403, "Você só pode reabrir suas próprias tarefas.");
    if (task.status === "pending" && task.dueDate <= last.scheduledDate)
      fail(409, "Esta conclusão já foi reaberta.");
    await change(
      tx,
      task,
      {
        status: "pending",
        assigneeId: null,
        dueDate: last.scheduledDate,
      },
      actor,
      "reopened",
      {
        completionId: last.id,
        previousDueDate: day(task.dueDate),
        scheduledDate: day(last.scheduledDate),
        previousAssigneeId: task.assigneeId,
      },
    );
  });
  res.json({ ok: true });
});
tasksRouter.post("/:id/completions", async (req, res) => {
  const actor = requireUser(res.locals.actor);
  const body = z
    .object({
      version,
      residentId: z.string().uuid(),
      durationMinutes: minutes,
    })
    .parse(req.body);
  const key = z.string().uuid().parse(req.header("Idempotency-Key"));
  const taskId = String(req.params.id);
  const hash = sha(JSON.stringify({ taskId, actor: actor.id, ...body }));
  const run = async () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.taskCompletion.findUnique({
        where: { idempotencyKey: key },
      });
      if (existing) {
        if (existing.requestHash !== hash) fail(409, "Chave já utilizada.");
        return existing.id;
      }
      const task = await load(tx, taskId, body.version);
      if (
        actor.role !== "admin" &&
        (!actor.residentId ||
          task.assigneeId !== actor.residentId ||
          body.residentId !== actor.residentId)
      )
        fail(403, "Conclua apenas suas tarefas, com sua identidade.");
      await resident(tx, body.residentId);
      const now = new Date(),
        today = houseDate(now),
        due = day(task.dueDate),
        recurrence = task.recurrence as TaskRecurrence;
      const next =
        recurrence.kind === "once"
          ? due
          : nextOccurrence(
              { recurrence, dueDate: due },
              due > today ? due : today,
            );
      await change(
        tx,
        task,
        {
          status: recurrence.kind === "once" ? "completed" : "pending",
          dueDate: dbDate(next),
        },
        actor,
        "completed",
        {
          scheduledDate: due,
          residentId: body.residentId,
          durationMinutes: body.durationMinutes,
        },
      );
      const completion = await tx.taskCompletion.create({
        data: {
          taskId,
          scheduledDate: task.dueDate,
          completedAt: now,
          residentId: body.residentId,
          durationMinutes: body.durationMinutes,
          actorId: actor.id,
          idempotencyKey: key,
          requestHash: hash,
          taskSnapshot: {
            weightHours: task.weightHours,
            name: task.name,
            area: areas[areaKeys.indexOf(task.area)],
            recurrence,
          },
        },
      });
      return completion.id;
    });
  try {
    res.json({ id: await run() });
  } catch (error) {
    const existing = await prisma.taskCompletion.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing?.requestHash === hash) res.json({ id: existing.id });
    else throw error;
  }
});
tasksRouter.get("/:id/events", async (req, res) => {
  requireAdmin(res.locals.actor);
  res.json(
    await prisma.taskEvent.findMany({
      where: { taskId: String(req.params.id) },
      orderBy: { createdAt: "desc" },
    }),
  );
});
export const completionRouter = Router();
completionRouter.get("/", async (_req, res) =>
  res.json(
    (
      await prisma.taskCompletion.findMany({ orderBy: { completedAt: "desc" } })
    ).map((c) => ({
      ...c,
      scheduledDate: day(c.scheduledDate),
      idempotencyKey: undefined,
      requestHash: undefined,
      actorId: undefined,
    })),
  ),
);
completionRouter.patch("/:id", async (req, res) => {
  const actor = requireUser(res.locals.actor);
  const body = z.object({ version, durationMinutes: minutes }).parse(req.body);
  await prisma.$transaction(async (tx) => {
    const record = await tx.taskCompletion.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!record) return fail(404, "Conclusão não encontrada.");
    if (actor.role !== "admin" && record.residentId !== actor.residentId)
      fail(403, "Registro de outro morador.");
    const updated = await tx.taskCompletion.updateMany({
      where: { id: record.id, version: body.version },
      data: {
        durationMinutes: body.durationMinutes,
        version: { increment: 1 },
      },
    });
    if (!updated.count) fail(409, "Registro atualizado por outra pessoa.");
    await tx.taskEvent.create({
      data: {
        taskId: record.taskId,
        actorId: actor.id,
        kind: "duration_corrected",
        data: {
          completionId: record.id,
          from: record.durationMinutes,
          to: body.durationMinutes,
        },
      },
    });
  });
  res.json({ ok: true });
});
