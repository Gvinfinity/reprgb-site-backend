import { Router } from "express";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "../PrismaClient.js";
import { requireAdmin, revocations } from "../auth.js";
import { origin } from "../config.js";
import { fail, sha } from "../core/http.js";
const personInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  active: z.boolean().default(true),
  isHousemate: z.boolean().default(true),
});
export const accountsRouter = Router();
accountsRouter.get("/me", (_req, res) => res.json(res.locals.actor));
accountsRouter.get("/residents", async (_req, res) =>
  res.json(
    await prisma.person.findMany({
      select: {
        id: true,
        name: true,
        color: true,
        active: true,
        isHousemate: true,
      },
      orderBy: { name: "asc" },
    }),
  ),
);
accountsRouter.post("/residents", async (req, res) => {
  requireAdmin(res.locals.actor);
  res
    .status(201)
    .json(await prisma.person.create({ data: personInput.parse(req.body) }));
});
accountsRouter.patch("/residents/:id", async (req, res) => {
  requireAdmin(res.locals.actor);
  res.json(
    await prisma.person.update({
      where: { id: String(req.params.id) },
      data: personInput
        .pick({ name: true, color: true })
        .extend({ active: z.boolean(), isHousemate: z.boolean() })
        .partial()
        .parse(req.body),
    }),
  );
});
accountsRouter.get("/accounts", async (_req, res) => {
  requireAdmin(res.locals.actor);
  res.json(
    await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        residentId: true,
      },
    }),
  );
});
accountsRouter.patch("/accounts/:id", async (req, res) => {
  const actor = requireAdmin(res.locals.actor),
    id = String(req.params.id),
    body = z.object({ active: z.boolean() }).parse(req.body);
  if (id === actor.id && !body.active)
    fail(400, "Não desative sua própria conta.");
  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) fail(404, "Conta não encontrada.");
    if (target?.role === "admin" && !body.active)
      fail(400, "Contas administrativas são gerenciadas no servidor.");
    await tx.user.update({ where: { id }, data: body });
    await tx.session.deleteMany({ where: { userId: id } });
  });
  revocations.emit("user", id);
  res.json({ ok: true });
});
accountsRouter.post("/accounts/:id/revoke", async (req, res) => {
  requireAdmin(res.locals.actor);
  const id = String(req.params.id);
  await prisma.session.deleteMany({ where: { userId: id } });
  revocations.emit("user", id);
  res.json({ ok: true });
});
accountsRouter.get("/invitations", async (_req, res) => {
  requireAdmin(res.locals.actor);
  res.json(
    await prisma.invitation.findMany({
      select: {
        id: true,
        email: true,
        residentId: true,
        expiresAt: true,
        usedAt: true,
        createdAt: true,
      },
    }),
  );
});
accountsRouter.post("/invitations", async (req, res) => {
  requireAdmin(res.locals.actor);
  const body = z
    .object({
      email: z.email().transform((s) => s.toLowerCase()),
      residentId: z.string().uuid(),
    })
    .parse(req.body);
  const person = await prisma.person.findUnique({
    where: { id: body.residentId },
    include: { user: true },
  });
  if (!person?.active || !person.isHousemate || person.user)
    fail(400, "Selecione um morador ativo sem conta.");
  const token = randomBytes(32).toString("base64url");
  const record = await prisma.$transaction(async (tx) => {
    await tx.invitation.deleteMany({
      where: { residentId: body.residentId, usedAt: null },
    });
    return tx.invitation.create({
      data: {
        ...body,
        tokenHash: sha(token),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
  });
  res.status(201).json({
    id: record.id,
    url: origin + "/register?invite=" + token,
    expiresAt: record.expiresAt,
  });
});
accountsRouter.post("/register", async (req, res) => {
  const body = z
    .object({
      token: z.string().min(20).max(200),
      name: z.string().trim().min(1).max(100),
      email: z.email().transform((s) => s.toLowerCase()),
      password: z.string().min(10).max(128),
    })
    .strict()
    .parse(req.body);
  const password = await hashPassword(body.password);
  await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { tokenHash: sha(body.token) },
    });
    if (
      !invitation ||
      invitation.usedAt ||
      invitation.expiresAt <= new Date() ||
      invitation.email !== body.email
    )
      fail(400, "Convite inválido ou expirado.");
    const invite = invitation!;
    const resident = await tx.person.findUnique({
      where: { id: invite.residentId },
      include: { user: true },
    });
    if (!resident?.active || resident.user) fail(400, "Morador indisponível.");
    const used = await tx.invitation.updateMany({
      where: { id: invite.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!used.count) fail(409, "Convite já utilizado.");
    const id = randomUUID();
    await tx.user.create({
      data: {
        id,
        name: body.name,
        email: body.email,
        residentId: invite.residentId,
        accounts: {
          create: {
            id: randomUUID(),
            providerId: "credential",
            accountId: id,
            password,
          },
        },
      },
    });
  });
  res.status(201).json({ ok: true });
});
