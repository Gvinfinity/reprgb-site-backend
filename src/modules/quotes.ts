import { Router } from "express";
import multer from "multer";
import { prisma } from "../PrismaClient.js";
import { requireAdmin } from "../auth.js";
import { quoteInput } from "../core/schemas.js";
import { dbDate, day, fail, sha } from "../core/http.js";
export interface ParsedQuoteDraft {
  text: string;
  author: string | null;
  date?: string;
  sourceLocation: string;
}
export interface QuoteParser {
  parse(content: string): Promise<ParsedQuoteDraft[]>;
}
export const quoteRouter = Router();
quoteRouter.get("/", async (req, res) => {
  const normalize = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR");
  const query = normalize(String(req.query.q || "").trim());
  res.json(
    (await prisma.quote.findMany({ orderBy: { createdAt: "asc" } }))
      .filter((q) => normalize(q.text + " " + q.author).includes(query))
      .map((q) => ({ ...q, date: q.date ? day(q.date) : undefined })),
  );
});
quoteRouter.post("/", async (req, res) => {
  requireAdmin(res.locals.actor);
  const b = quoteInput.parse(req.body);
  res
    .status(201)
    .json(
      await prisma.quote.create({
        data: { ...b, date: b.date ? dbDate(b.date) : null },
      }),
    );
});
quoteRouter.put("/:id", async (req, res) => {
  requireAdmin(res.locals.actor);
  const b = quoteInput.parse(req.body);
  res.json(
    await prisma.quote.update({
      where: { id: String(req.params.id) },
      data: { ...b, date: b.date ? dbDate(b.date) : null },
    }),
  );
});
quoteRouter.delete("/:id", async (req, res) => {
  requireAdmin(res.locals.actor);
  await prisma.quote.delete({ where: { id: String(req.params.id) } });
  res.status(204).end();
});
export const quoteImportsRouter = Router();
quoteImportsRouter.use((_req, res, next) => {
  requireAdmin(res.locals.actor);
  next();
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 0 },
});
quoteImportsRouter.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file || !file.originalname.toLowerCase().endsWith(".txt"))
    fail(400, "Selecione um arquivo TXT.");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(file!.buffer);
  } catch {
    return fail(400, "O arquivo precisa ser UTF-8 válido.");
  }
  if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))
    fail(400, "Arquivo vazio ou inválido.");
  const checksum = sha(file!.buffer),
    actor = requireAdmin(res.locals.actor);
  const record = await prisma.quoteImport.upsert({
    where: { checksum },
    update: {},
    create: {
      checksum,
      filename: file!.originalname.replace(/.*[\\/]/, "").slice(0, 200),
      content,
      uploaderId: actor.id,
    },
  });
  res
    .status(202)
    .json({ id: record.id, status: record.status, filename: record.filename });
});
quoteImportsRouter.get("/", async (_req, res) =>
  res.json(
    await prisma.quoteImport.findMany({
      select: { id: true, status: true, filename: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ),
);
quoteImportsRouter.get("/:id", async (req, res) => {
  const record = await prisma.quoteImport.findUnique({
    where: { id: String(req.params.id) },
  });
  if (!record) fail(404, "Importação não encontrada.");
  res.json({ ...record, content: record!.content.slice(0, 10000) });
});
