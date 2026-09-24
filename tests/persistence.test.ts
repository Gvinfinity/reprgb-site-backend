import { beforeAll, afterAll, it, expect, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hashPassword } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import { prisma } from "../src/PrismaClient.js";
import { createApp } from "../src/app.js";
import { backupDatabase, restoreDatabase } from "../src/core/backup.js";
const app = createApp();
let cookie: string[], personId: string;
beforeAll(async () => {
  const id = randomUUID();
  personId = (
    await prisma.person.create({
      data: { name: "Historic resident", isHousemate: true, active: false },
    })
  ).id;
  await prisma.user.create({
    data: {
      id,
      email: "persistence@test.com",
      name: "Admin",
      role: "admin",
      accounts: {
        create: {
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          password: await hashPassword("persistence-password"),
        },
      },
    },
  });
  const login = await request(app)
    .post("/api/auth/sign-in/email")
    .send({ email: "persistence@test.com", password: "persistence-password" });
  expect(login.status, login.text).toBe(200);
  cookie = login.headers["set-cookie"] as unknown as string[];
});
afterAll(() => prisma.$disconnect());
const oldTask = (id: string) => ({
  id,
  name: "Imported " + id,
  area: "Cozinha",
  assigneeId: "old-resident",
  recurrence: { kind: "monthly", dayOfMonth: 31 },
  dueDate: "2026-09-30",
  status: "archived",
  completions: [
    {
      id: "old-completion",
      scheduledDate: "2026-08-31",
      completedAt: "2026-09-01T12:00:00Z",
      residentId: "old-resident",
      durationMinutes: 42,
    },
  ],
});
it("previews mappings, imports atomically, preserves history and deduplicates", async () => {
  const snapshot = {
    version: 3,
    tasks: [oldTask("old-task")],
    quotes: [{ id: "old-quote", text: "Olá", author: "Ana" }],
    screenings: [
      {
        id: "old-film",
        title: "Manual movie",
        year: 2020,
        genre: "Drama",
        duration: 90,
        synopsis: "",
        status: "upcoming",
      },
    ],
  };
  const preview = await request(app)
    .post("/api/v1/data-imports/preview")
    .set("Cookie", cookie)
    .send({ snapshot, mapping: {} });
  expect(preview.status, preview.text).toBe(200);
  expect(preview.body.missing).toEqual(["old-resident"]);
  const payload = { snapshot, mapping: { "old-resident": personId } };
  const commit = await request(app)
    .post("/api/v1/data-imports/commit")
    .set("Cookie", cookie)
    .send(payload);
  expect(commit.status, commit.text).toBe(201);
  const retry = await request(app)
    .post("/api/v1/data-imports/commit")
    .set("Cookie", cookie)
    .send(payload);
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(commit.body);
  const task = await prisma.task.findFirstOrThrow({
    where: { name: "Imported old-task" },
    include: { completions: true },
  });
  expect(task.status).toBe("archived");
  expect(task.assigneeId).toBe(personId);
  expect(task.dueDate.toISOString().slice(0, 10)).toBe("2026-09-30");
  expect(task.completions[0].durationMinutes).toBe(42);
  expect(task.completions[0].residentId).toBe(personId);
  const conflict = await request(app)
    .post("/api/v1/data-imports/preview")
    .set("Cookie", cookie)
    .send(payload);
  expect(conflict.body.conflicts).toContain("task:old-task");
  const before = await prisma.task.count();
  const broken = {
    ...snapshot,
    tasks: [
      oldTask("rollback-one"),
      { ...oldTask("rollback-two"), status: "completed" },
    ],
    quotes: [],
    screenings: [],
  };
  expect(
    (
      await request(app)
        .post("/api/v1/data-imports/commit")
        .set("Cookie", cookie)
        .send({ snapshot: broken, mapping: payload.mapping })
    ).status,
  ).toBe(400);
  expect(await prisma.task.count()).toBe(before);
  expect(
    await prisma.importSource.findUnique({
      where: { key: "task:rollback-one" },
    }),
  ).toBeNull();
});
it("persists manual cinema and isolates failed TMDB searches", async () => {
  const created = await request(app)
    .post("/api/v1/screenings")
    .set("Cookie", cookie)
    .send({
      title: "Persistent movie",
      year: 2024,
      genre: "Drama",
      duration: 110,
      synopsis: "",
      status: "upcoming",
    });
  expect(created.status, created.text).toBe(201);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("offline"));
  try {
    expect(
      (
        await request(app)
          .get("/api/v1/movies/search?q=offline")
          .set("Cookie", cookie)
      ).status,
    ).toBe(502);
    expect(
      (await request(app).get("/api/v1/screenings")).body.some(
        (s: any) => s.title === "Persistent movie",
      ),
    ).toBe(true);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 42,
              title: "Teste",
              release_date: "2024-01-01",
              poster_path: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(
      (
        await request(app)
          .get("/api/v1/movies/search?q=cache-test")
          .set("Cookie", cookie)
      ).body[0].tmdbId,
    ).toBe(42);
    await request(app)
      .get("/api/v1/movies/search?q=cache-test")
      .set("Cookie", cookie);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    fetchMock.mockRestore();
  }
  const reconnected = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  try {
    expect(
      await reconnected.screening.findUnique({
        where: { id: created.body.id },
      }),
    ).not.toBeNull();
  } finally {
    await reconnected.$disconnect();
  }
});
it("restores a checksum-verified backup to a migrated empty PostgreSQL database", async () => {
  const backup = await backupDatabase(prisma);
  await prisma.$executeRawUnsafe("CREATE DATABASE reprgb_restore");
  const url = process.env.DATABASE_URL!.replace(
    "/reprgb_test",
    "/reprgb_restore",
  );
  execFileSync(
    "node",
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
  );
  const restored = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    await expect(
      restoreDatabase(restored, { ...backup, checksum: "invalid" }),
    ).rejects.toThrow("Backup inválido");
    await restoreDatabase(restored, backup);
    expect(await restored.task.count()).toBe(await prisma.task.count());
    expect(await restored.taskCompletion.count()).toBe(
      await prisma.taskCompletion.count(),
    );
    expect(await restored.quoteImport.count()).toBe(
      await prisma.quoteImport.count(),
    );
    expect(
      await restored.person.findUnique({ where: { id: personId } }),
    ).toMatchObject({ active: false, name: "Historic resident" });
    await expect(restoreDatabase(restored, backup)).rejects.toThrow(
      "banco vazio",
    );
  } finally {
    await restored.$disconnect();
  }
}, 30000);

it("edits manual screenings, schedules announcements and corrects undated past sessions", async () => {
  const input = {
    title: "Editable manual movie",
    year: 2020,
    genre: "Drama",
    duration: 90,
    synopsis: "",
    status: "past",
  };
  const created = await request(app)
    .post("/api/v1/screenings")
    .set("Cookie", cookie)
    .send(input);
  expect(created.status, created.text).toBe(201);
  const list = async () =>
    (await request(app).get("/api/v1/screenings")).body.find(
      (s: any) => s.id === created.body.id,
    );
  let saved = await list();
  expect(saved.scheduledAt).toBeUndefined();
  expect(saved.tmdbId).toBeUndefined();
  const update = await request(app)
    .put("/api/v1/screenings/" + saved.id)
    .set("Cookie", cookie)
    .send({
      ...saved,
      tmdbId: null,
      title: "Corrected title",
      scheduledAt: "2026-09-20T20:00:00-03:00",
    });
  expect(update.status, update.text).toBe(200);
  saved = await list();
  expect(saved.title).toBe("Corrected title");
  expect(saved.scheduledAt).toBe("2026-09-20T23:00:00.000Z");
  expect(
    (
      await request(app)
        .put("/api/v1/screenings/" + saved.id)
        .set("Cookie", cookie)
        .send({ ...saved, version: 0 })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(app)
        .put("/api/v1/screenings/" + saved.id)
        .set("Cookie", cookie)
        .send({ ...saved, status: "upcoming", scheduledAt: undefined })
    ).status,
  ).toBe(200);
  saved = await list();
  expect(saved.status).toBe("upcoming");
  expect(saved.scheduledAt).toBeUndefined();
  expect(
    (
      await request(app)
        .put("/api/v1/screenings/" + saved.id)
        .set("Cookie", cookie)
        .send({ ...saved, scheduledAt: "2026-10-10T20:00:00-03:00" })
    ).status,
  ).toBe(200);
  expect((await list()).scheduledAt).toBe("2026-10-10T23:00:00.000Z");
});

it("imports Notion task definitions with precise hours, one-offs, deduplication and no completion logs", async () => {
  const rows = [
    {
      sourceId: randomUUID(),
      name: "Catalog recurring",
      area: "Garagem",
      periodDays: 28,
      weightHours: 1.13,
    },
    {
      sourceId: randomUUID(),
      name: "Catalog exceptional",
      area: "Outro",
      periodDays: null,
      weightHours: null,
    },
  ];
  const body = { source: "notion", startDate: "2026-09-24", rows };
  const preview = await request(app)
    .post("/api/v1/task-imports/preview")
    .set("Cookie", cookie)
    .send(body);
  expect(preview.status, preview.text).toBe(200);
  expect(preview.body).toMatchObject({
    total: 2,
    recurring: 1,
    exceptional: 1,
    missingWeights: 1,
    toCreate: 2,
  });
  expect(
    (await request(app).post("/api/v1/task-imports/commit").send(body)).status,
  ).toBe(401);
  const [first, second] = await Promise.all([
    request(app)
      .post("/api/v1/task-imports/commit")
      .set("Cookie", cookie)
      .send(body),
    request(app)
      .post("/api/v1/task-imports/commit")
      .set("Cookie", cookie)
      .send(body),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 201]);
  expect(first.body.created + second.body.created).toBe(2);
  const tasks = await prisma.task.findMany({
    where: { name: { in: rows.map((row) => row.name) } },
    include: { completions: true },
  });
  expect(tasks).toHaveLength(2);
  const recurring = tasks.find((t) => t.name === rows[0].name)!;
  expect(recurring.recurrence).toEqual({
    kind: "interval",
    everyDays: 28,
    anchorDate: "2026-09-24",
  });
  expect(recurring.weightHours).toBe(1.13);
  expect(recurring.assigneeId).toBeNull();
  expect(recurring.completions).toEqual([]);
  const exceptional = tasks.find((t) => t.name === rows[1].name)!;
  expect(exceptional.recurrence).toEqual({ kind: "once" });
  expect(exceptional.weightHours).toBeNull();
  expect(exceptional.status).toBe("pending");
  const changed = {
    ...body,
    rows: [
      {
        sourceId: randomUUID(),
        name: "Must roll back",
        area: "Outro",
        periodDays: 3,
        weightHours: 0,
      },
      { ...rows[0], weightHours: 2 },
    ],
  };
  expect(
    (
      await request(app)
        .post("/api/v1/task-imports/commit")
        .set("Cookie", cookie)
        .send(changed)
    ).status,
  ).toBe(409);
  expect(await prisma.task.count({ where: { name: "Must roll back" } })).toBe(
    0,
  );
  expect(
    (
      await request(app)
        .post("/api/v1/task-imports/preview")
        .set("Cookie", cookie)
        .send({ ...body, rows: [{ ...rows[0], periodDays: 0 }] })
    ).status,
  ).toBe(400);
  // Editing without the optional weight field must preserve the imported reference value.
  const edit = await request(app)
    .patch("/api/v1/tasks/" + recurring.id)
    .set("Cookie", cookie)
    .send({
      name: recurring.name,
      area: "Garagem",
      assigneeId: null,
      recurrence: recurring.recurrence,
      dueDate: "2026-09-24",
      version: 0,
    });
  expect(edit.status, edit.text).toBe(200);
  expect(
    (await prisma.task.findUniqueOrThrow({ where: { id: recurring.id } }))
      .weightHours,
  ).toBe(1.13);
});
