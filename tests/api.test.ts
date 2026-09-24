import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createApp } from "../src/app.js";
import { prisma } from "../src/PrismaClient.js";
import { houseDate, addDays } from "../src/core/schedule.js";
import { sha } from "../src/core/http.js";
const app = createApp();
let admin: string[],
  ana: string[],
  bento: string[],
  anaId: string,
  bentoId: string,
  userId: string,
  taskId: string;
const password = "correct-test-password";
async function login(email: string) {
  const response = await request(app)
    .post("/api/auth/sign-in/email")
    .set("Origin", "http://localhost:3000")
    .send({ email, password });
  expect(response.status, response.text).toBe(200);
  return response.headers["set-cookie"] as unknown as string[];
}
beforeAll(async () => {
  for (const [email, role, name] of [
    ["admin@test.com", "admin", "Admin"],
    ["ana@test.com", "resident", "Ana"],
    ["bento@test.com", "resident", "Bento"],
  ]) {
    const id = randomUUID();
    const person =
      role === "resident"
        ? await prisma.person.create({ data: { name, isHousemate: true } })
        : null;
    if (name === "Ana") anaId = person!.id;
    if (name === "Bento") bentoId = person!.id;
    await prisma.user.create({
      data: {
        id,
        name,
        email,
        role,
        residentId: person?.id,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: id,
            providerId: "credential",
            password: await hashPassword(password),
          },
        },
      },
    });
    if (name === "Ana") userId = id;
  }
  admin = await login("admin@test.com");
  ana = await login("ana@test.com");
  bento = await login("bento@test.com");
});
afterAll(() => prisma.$disconnect());
describe("real database API", () => {
  it("protects writes, account data, legacy routes and camera reads", async () => {
    for (const path of [
      "/api/v1/accounts",
      "/api/v1/people",
      "/api/v1/cameras",
    ])
      expect((await request(app).get(path)).status).toBe(401);
    expect(
      (await request(app).post("/api/v1/tasks").set("Cookie", ana).send({}))
        .status,
    ).toBe(403);
    expect((await request(app).get("/api/v1/tasks")).status).toBe(200);
    expect(
      (await request(app).post("/api/auth/sign-up/email").send({})).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/api/v1/quotes")
          .set("Cookie", admin)
          .set("Origin", "https://evil.example")
          .send({})
      ).status,
    ).toBe(403);
  });
  it("creates tasks and checks versions, ownership, return and attribution", async () => {
    const created = await request(app)
      .post("/api/v1/tasks")
      .set("Cookie", admin)
      .send({
        name: "Cozinha",
        area: "Cozinha",
        assigneeId: null,
        recurrence: { kind: "weekly", weekdays: [1, 5] },
        dueDate: "2026-09-21",
      });
    expect(created.status, created.text).toBe(201);
    taskId = created.body.id;
    const claim = await request(app)
      .patch("/api/v1/tasks/" + taskId + "/assignment")
      .set("Cookie", ana)
      .send({ assigneeId: anaId, version: 0 });
    expect(claim.status, claim.text).toBe(200);
    expect(
      (
        await request(app)
          .patch("/api/v1/tasks/" + taskId + "/assignment")
          .set("Cookie", bento)
          .send({ assigneeId: null, version: 1 })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/api/v1/tasks/" + taskId + "/assignment")
          .set("Cookie", ana)
          .send({ assigneeId: null, version: 1 })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch("/api/v1/tasks/" + taskId + "/assignment")
          .set("Cookie", ana)
          .send({ assigneeId: anaId, version: 0 })
      ).status,
    ).toBe(409);
    await request(app)
      .patch("/api/v1/tasks/" + taskId + "/assignment")
      .set("Cookie", ana)
      .send({ assigneeId: anaId, version: 2 });
    const key = randomUUID();
    expect(
      (
        await request(app)
          .post("/api/v1/tasks/" + taskId + "/completions")
          .set("Cookie", ana)
          .set("Idempotency-Key", key)
          .send({ version: 3, residentId: bentoId, durationMinutes: 20 })
      ).status,
    ).toBe(403);
    const complete = () =>
      request(app)
        .post("/api/v1/tasks/" + taskId + "/completions")
        .set("Cookie", ana)
        .set("Idempotency-Key", key)
        .send({ version: 3, residentId: anaId, durationMinutes: 20 });
    const [one, two] = await Promise.all([complete(), complete()]);
    expect(one.status, one.text).toBe(200);
    expect(two.status, two.text).toBe(200);
    expect(one.body.id).toBe(two.body.id);
    expect(await prisma.taskCompletion.count({ where: { taskId } })).toBe(1);
    expect(
      (
        await request(app)
          .patch("/api/v1/completions/" + one.body.id)
          .set("Cookie", bento)
          .send({ version: 0, durationMinutes: 50 })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/api/v1/completions/" + one.body.id)
          .set("Cookie", ana)
          .send({ version: 0, durationMinutes: 30 })
      ).status,
    ).toBe(200);
  });
  it("stores TXT once without creating quotes", async () => {
    const before = await prisma.quote.count();
    const upload = () =>
      request(app)
        .post("/api/v1/quote-imports")
        .set("Cookie", admin)
        .attach("file", Buffer.from("Olá — Ana"), "quotes.txt");
    const a = await upload(),
      b = await upload();
    expect(a.status, a.text).toBe(202);
    expect(a.body.status).toBe("awaiting_parser");
    expect(b.body.id).toBe(a.body.id);
    expect(await prisma.quote.count()).toBe(before);
    expect(
      (
        await request(app)
          .post("/api/v1/quote-imports")
          .set("Cookie", admin)
          .attach("file", Buffer.from([0xff]), "bad.txt")
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/v1/quote-imports")
          .set("Cookie", admin)
          .attach("file", Buffer.alloc(1024 * 1024 + 1), "large.txt")
      ).status,
    ).toBe(413);
  });
  it("requires a single-use invitation and rejects identity/role injection", async () => {
    const person = await prisma.person.create({
      data: { name: "Invited", isHousemate: true },
    });
    const invited = await request(app)
      .post("/api/v1/invitations")
      .set("Cookie", admin)
      .send({ email: "invited@test.com", residentId: person.id });
    expect(invited.status, invited.text).toBe(201);
    const token = new URL(invited.body.url).searchParams.get("invite");
    const body = {
      token,
      name: "Invited",
      email: "invited@test.com",
      password,
    };
    expect(
      (
        await request(app)
          .post("/api/v1/register")
          .send({ ...body, role: "admin" })
      ).status,
    ).toBe(400);
    const responses = await Promise.all([
      request(app).post("/api/v1/register").send(body),
      request(app).post("/api/v1/register").send(body),
    ]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "invited@test.com" },
    });
    expect(user.role).toBe("resident");
    expect(user.residentId).toBe(person.id);
    expect(
      await prisma.invitation.findFirst({ where: { tokenHash: sha(token!) } }),
    ).not.toHaveProperty("token");
  });
  it("rejects expired invitations, wrong emails and public access to administrative data", async () => {
    const person = await prisma.person.create({
        data: { name: "Expired invite", isHousemate: true },
      }),
      token = randomBytes(32).toString("base64url");
    await prisma.invitation.create({
      data: {
        email: "expired@test.com",
        residentId: person.id,
        tokenHash: sha(token),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(
      (
        await request(app)
          .post("/api/v1/register")
          .send({ token, name: "Expired", email: "expired@test.com", password })
      ).status,
    ).toBe(400);
    await prisma.invitation.updateMany({
      where: { residentId: person.id },
      data: { expiresAt: new Date(Date.now() + 86400000) },
    });
    expect(
      (
        await request(app)
          .post("/api/v1/register")
          .send({ token, name: "Wrong", email: "other@test.com", password })
      ).status,
    ).toBe(400);
    for (const path of [
      "/api/v1/quotes",
      "/api/v1/screenings",
      "/api/v1/residents",
      "/api/v1/invitations",
      "/api/v1/data-imports/preview",
    ]) {
      expect(
        (await request(app).post(path).set("Cookie", bento).send({})).status,
      ).toBe(403);
    }
    const people = (await request(app).get("/api/v1/residents")).body;
    expect(Object.keys(people[0]).sort()).toEqual([
      "active",
      "color",
      "id",
      "isHousemate",
      "name",
    ]);
    expect(
      (
        await request(app)
          .get("/api/v1/tasks/" + taskId + "/events")
          .set("Cookie", ana)
      ).status,
    ).toBe(403);
  });
  it("resolves concurrent claims and lets administrators reassign and complete for a resident", async () => {
    const made = await request(app)
      .post("/api/v1/tasks")
      .set("Cookie", admin)
      .send({
        name: "Concurrent",
        area: "Casa toda",
        assigneeId: null,
        recurrence: { kind: "once" },
        dueDate: houseDate(),
      });
    expect(made.status, made.text).toBe(201);
    const path = "/api/v1/tasks/" + made.body.id;
    const results = await Promise.all([
      request(app)
        .patch(path + "/assignment")
        .set("Cookie", ana)
        .send({ version: 0, assigneeId: anaId }),
      request(app)
        .patch(path + "/assignment")
        .set("Cookie", bento)
        .send({ version: 0, assigneeId: bentoId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await request(app)
          .patch(path + "/assignment")
          .set("Cookie", admin)
          .send({ version: 1, assigneeId: anaId })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(path + "/completions")
          .set("Cookie", admin)
          .set("Idempotency-Key", randomUUID())
          .send({ version: 2, residentId: bentoId, durationMinutes: 15 })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(path + "/archive")
          .set("Cookie", admin)
          .send({ version: 3 })
      ).status,
    ).toBe(200);
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: made.body.id },
      include: { completions: true },
    });
    expect(task.status).toBe("archived");
    expect(task.completions[0].residentId).toBe(bentoId);
    expect(task.completions[0].durationMinutes).toBe(15);
  });
  it("atomically advances fixed dates for early and overdue completions", async () => {
    const today = houseDate();
    for (const offset of [14, -28]) {
      const due = addDays(today, offset),
        expected = addDays(today, offset > 0 ? 28 : 14);
      const made = await request(app)
        .post("/api/v1/tasks")
        .set("Cookie", admin)
        .send({
          name: "Fixed " + offset,
          area: "Cozinha",
          assigneeId: bentoId,
          recurrence: { kind: "fortnightly", anchorDate: due },
          dueDate: due,
        });
      expect(made.status, made.text).toBe(201);
      const result = await request(app)
        .post("/api/v1/tasks/" + made.body.id + "/completions")
        .set("Cookie", bento)
        .set("Idempotency-Key", randomUUID())
        .send({ version: 0, residentId: bentoId, durationMinutes: null });
      expect(result.status, result.text).toBe(200);
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: made.body.id },
        include: { completions: true },
      });
      expect(task.dueDate.toISOString().slice(0, 10)).toBe(expected);
      expect(task.completions).toHaveLength(1);
      expect(task.completions[0].scheduledDate.toISOString().slice(0, 10)).toBe(
        due,
      );
    }
  });
  it("reopens completed tasks without losing history or shifting recurrence", async () => {
    for (const recurrence of [
      { kind: "once" },
      { kind: "interval", everyDays: 14, anchorDate: houseDate() },
    ]) {
      const created = await request(app)
        .post("/api/v1/tasks")
        .set("Cookie", admin)
        .send({
          name: "Reabrir",
          area: "Cozinha",
          assigneeId: anaId,
          recurrence,
          dueDate: houseDate(),
        });
      expect(created.status, created.text).toBe(201);
      const id = created.body.id;
      const path = "/api/v1/tasks/" + id;
      expect(
        (
          await request(app)
            .post(path + "/reopen")
            .set("Cookie", ana)
            .send({ version: 0 })
        ).status,
      ).toBe(409);
      const completed = await request(app)
        .post(path + "/completions")
        .set("Cookie", ana)
        .set("Idempotency-Key", randomUUID())
        .send({ version: 0, residentId: anaId, durationMinutes: 10 });
      expect(completed.status, completed.text).toBe(200);
      expect(
        (
          await request(app)
            .post(path + "/reopen")
            .send({ version: 1 })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(app)
            .post(path + "/reopen")
            .set("Cookie", bento)
            .send({ version: 1 })
        ).status,
      ).toBe(403);
      const reopen = () =>
        request(app)
          .post(path + "/reopen")
          .set("Cookie", ana)
          .send({ version: 1 });
      const results = await Promise.all([reopen(), reopen()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const task = await prisma.task.findUniqueOrThrow({
        where: { id },
        include: { completions: true },
      });
      expect(task.status).toBe("pending");
      expect(task.assigneeId).toBeNull();
      expect(task.dueDate.toISOString().slice(0, 10)).toBe(houseDate());
      expect(task.recurrence).toEqual(recurrence);
      expect(task.completions).toHaveLength(1);
      expect(task.completions[0].durationMinutes).toBe(10);
      expect(
        (
          await request(app)
            .post(path + "/reopen")
            .set("Cookie", admin)
            .send({ version: 2 })
        ).status,
      ).toBe(409);
      const repeated = await request(app)
        .post(path + "/completions")
        .set("Cookie", admin)
        .set("Idempotency-Key", randomUUID())
        .send({ version: 2, residentId: bentoId, durationMinutes: 20 });
      expect(repeated.status, repeated.text).toBe(200);
      const after = await prisma.task.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe(
        recurrence.kind === "once" ? "completed" : "pending",
      );
      expect(after.dueDate.toISOString().slice(0, 10)).toBe(
        recurrence.kind === "once" ? houseDate() : addDays(houseDate(), 14),
      );
      expect(await prisma.taskCompletion.count({ where: { taskId: id } })).toBe(
        2,
      );
      expect(
        (
          await request(app)
            .post(path + "/reopen")
            .set("Cookie", admin)
            .send({ version: 3 })
        ).status,
      ).toBe(200);
      expect(
        await prisma.taskEvent.count({
          where: { taskId: id, kind: "reopened" },
        }),
      ).toBe(2);
      await request(app)
        .post(path + "/archive")
        .set("Cookie", admin)
        .send({ version: 4 });
      expect(
        (
          await request(app)
            .post(path + "/reopen")
            .set("Cookie", admin)
            .send({ version: 5 })
        ).status,
      ).toBe(409);
    }
  });
  it("deactivates accounts and rejects their existing sessions", async () => {
    expect(
      (
        await request(app)
          .patch("/api/v1/accounts/" + userId)
          .set("Cookie", admin)
          .send({ active: false })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/v1/cameras").set("Cookie", ana)).status,
    ).toBe(401);
    const response = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "ana@test.com", password });
    expect(response.status).not.toBe(200);
  });
});
