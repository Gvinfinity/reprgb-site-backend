import express from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { toNodeHandler } from "better-auth/node";
import { apiReference } from "@scalar/express-api-reference";
import { prisma } from "./PrismaClient.js";
import { auth, getActor, requireAdmin, revocations } from "./auth.js";
import { config, origin } from "./config.js";
import { HttpError, log } from "./core/http.js";
import { accountsRouter } from "./modules/accounts.js";
import { tasksRouter, completionRouter } from "./modules/tasks.js";
import { quoteRouter, quoteImportsRouter } from "./modules/quotes.js";
import { cinemaRouter } from "./modules/cinema.js";
import { taskImportsRouter } from "./modules/taskImports.js";
import { importsRouter } from "./modules/imports.js";
import { camerasRouter } from "./modules/cameras.js";
import personRouter from "./routers/person.js";
import leaderboardRouter from "./routers/leaderboard.js";
import { openApiDocument } from "./openapi/config.js";
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use((req, res, next) => {
    const path = req.path;
    const id = randomUUID();
    res.setHeader("X-Request-ID", id);
    res.locals.requestId = id;
    res.on("finish", () =>
      log("request", { id, method: req.method, path, status: res.statusCode }),
    );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== origin
    ) {
      res.status(403).json({ error: "Origem não permitida." });
      return;
    }
    next();
  });
  const authLimiter = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.use("/api/auth", authLimiter);
  app.all("/api/auth/*splat", async (req, res) => {
    const allowed = [
      "/api/auth/sign-in/email",
      "/api/auth/sign-out",
      "/api/auth/get-session",
      "/api/auth/change-password",
    ];
    if (!allowed.includes(req.path)) {
      res.status(404).json({ error: "Endpoint indisponível." });
      return;
    }
    const actor = req.path.endsWith("sign-out")
      ? await getActor(req.headers)
      : null;
    if (actor)
      res.on("finish", () => {
        if (res.statusCode < 400) revocations.emit("user", actor.id);
      });
    await toNodeHandler(auth)(req, res);
  });
  app.use(express.json({ limit: "10mb" }));
  app.get(["/health", "/api/health"], (_req, res) =>
    res.json({ status: "ok" }),
  );
  app.get(["/ready", "/api/ready"], async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready" });
  });
  app.use("/api/v1", async (req, res, next) => {
    res.locals.actor = await getActor(req.headers);
    next();
  });
  app.use("/api/v1/register", authLimiter);
  app.use("/api/v1", accountsRouter, cinemaRouter);
  app.use("/api/v1/tasks", tasksRouter);
  app.use("/api/v1/completions", completionRouter);
  app.use("/api/v1/quotes", quoteRouter);
  app.use("/api/v1/quote-imports", quoteImportsRouter);
  app.use("/api/v1/data-imports", importsRouter);
  app.use("/api/v1/task-imports", taskImportsRouter);
  app.use("/api/v1/cameras", camerasRouter);
  const admin: express.RequestHandler = (_req, res, next) => {
    requireAdmin(res.locals.actor);
    next();
  };
  app.use("/api/v1/people", admin, personRouter);
  app.use("/api/v1/leaderboards", admin, leaderboardRouter);
  app.get("/api/v1/openapi.json", admin, (_req, res) =>
    res.json(openApiDocument),
  );
  app.use(
    "/api/v1/reference",
    admin,
    apiReference({ content: openApiDocument }),
  );
  app.use((_req, res) => res.status(404).json({ error: "Não encontrado." }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const code = (error as { code?: string })?.code;
      const bodyError = (error as { type?: string })?.type;
      const status =
        bodyError === "entity.too.large"
          ? 413
          : bodyError === "entity.parse.failed"
            ? 400
            : error instanceof HttpError
              ? error.status
              : error instanceof ZodError
                ? 400
                : error instanceof MulterError
                  ? 413
                  : code === "P2002" || code === "P2003"
                    ? 409
                    : code === "P2025"
                      ? 404
                      : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : status === 400
            ? "Dados inválidos."
            : status === 413
              ? "Arquivo excede o limite permitido."
              : status === 409
                ? "Registro duplicado ou em uso."
                : status === 404
                  ? "Registro não encontrado."
                  : "Falha no servidor.";
      log("error", {
        requestId: res.locals.requestId,
        status,
        kind: error instanceof Error ? error.name : "unknown",
      });
      res.status(status).json({
        error: message,
        requestId: res.locals.requestId,
        ...(error instanceof ZodError
          ? {
              issues: error.issues.map((i) => ({
                path: i.path,
                message: i.message,
              })),
            }
          : {}),
      });
    },
  );
  return app;
}
