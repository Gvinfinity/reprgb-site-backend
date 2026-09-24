// Local, disposable end-to-end test. Requires Chromium, ffmpeg and the frontend build.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import express from "express";
import EmbeddedPostgres from "embedded-postgres";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
const directory = mkdtempSync(join(tmpdir(), "reprgb-browser-"));
const pg = new EmbeddedPostgres({
  databaseDir: join(directory, "db"),
  user: "postgres",
  password: "browser-test-only",
  port: 55441,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
const origin = "http://localhost:55442";
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgresql://postgres:browser-test-only@127.0.0.1:55441/reprgb_browser",
  APP_ORIGIN: origin,
  BETTER_AUTH_SECRET: "browser-test-only-secret-with-at-least-32-characters",
  FRIGATE_AUTH_MODE: "internal",
  FRIGATE_URL: "http://127.0.0.1:55443",
  FRIGATE_CAMERAS: JSON.stringify([
    { id: "front", name: "Entrada", location: "Entrada", stream: "front" },
    { id: "yard", name: "Quintal", location: "Quintal", stream: "yard" },
  ]),
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let database: typeof import("../src/PrismaClient.js").prisma | undefined;
let server: ReturnType<typeof createServer> | undefined;
let wsServer:
  | ReturnType<typeof import("../src/modules/cameras.js").attachCameras>
  | undefined;
const source = new WebSocketServer({ port: 55443, host: "127.0.0.1" });
let peak = 0;
try {
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=10",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level:v",
    "4.1",
    "-g",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    join(directory, "sample.mp4"),
  ]);
  const media = readFileSync(join(directory, "sample.mp4"));
  source.on("connection", (socket) => {
    peak = Math.max(peak, source.clients.size);
    socket.on("message", (data) => {
      assert.equal(JSON.parse(data.toString()).type, "mse");
      socket.send(
        JSON.stringify({
          type: "mse",
          value: 'video/mp4; codecs="avc1.640029"',
        }),
      );
      socket.send(media);
    });
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("reprgb_browser");
  execFileSync(
    "node",
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: process.env, stdio: "pipe" },
  );
  const { prisma } = await import("../src/PrismaClient.js");
  database = prisma;
  const { hashPassword } = await import("better-auth/crypto");
  const resident = await prisma.person.create({
    data: { name: "Ana", isHousemate: true, color: "#00ff00" },
  });
  for (const role of ["admin", "resident"]) {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        name: role === "admin" ? "Admin" : "Ana",
        role,
        email: role + "@browser.test",
        residentId: role === "resident" ? resident.id : null,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: id,
            providerId: "credential",
            password: await hashPassword("browser-test-password"),
          },
        },
      },
    });
  }
  await prisma.task.create({
    data: {
      name: "Limpar bancada",
      area: "KITCHEN",
      recurrence: { kind: "once" },
      dueDate: new Date("2026-09-24T00:00:00Z"),
    },
  });
  await prisma.quote.create({
    data: { text: "Uma frase persistida", author: "Ana" },
  });
  const { createApp } = await import("../src/app.js");
  const { attachCameras } = await import("../src/modules/cameras.js");
  const outer = express();
  outer.use(express.static(resolve("../reprgb-site/build")));
  outer.get(/^(?!\/api(?:\/|$)).*/, (_req, res) =>
    res.sendFile(resolve("../reprgb-site/build/index.html")),
  );
  outer.use(createApp());
  server = createServer(outer);
  wsServer = attachCameras(server);
  await new Promise<void>((r) => server!.listen(55442, r));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const adminContext = await browser.newContext(),
    residentContext = await browser.newContext();
  const admin = await adminContext.newPage(),
    member = await residentContext.newPage();
  const errors: string[] = [];
  for (const page of [admin, member])
    page.on("pageerror", (e) => errors.push(e.message));
  const login = async (page: typeof admin, role: string) => {
    await page.goto(origin + "/login");
    await page
      .getByLabel("E-mail", { exact: true })
      .fill(role + "@browser.test");
    await page
      .getByLabel("Senha", { exact: true })
      .fill("browser-test-password");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("button", { name: "Sair", exact: true }).waitFor();
  };
  await login(admin, "admin");
  await login(member, "resident");
  await member.goto(origin + "/quotes");
  await member.getByText("Uma frase persistida", { exact: true }).waitFor();
  await admin.goto(origin + "/quotes");
  await admin
    .getByRole("button", { name: "Adicionar quote", exact: true })
    .click();
  await admin
    .getByLabel("Frase", { exact: true })
    .fill("Persistida entre navegadores");
  await admin.getByLabel("Autor", { exact: true }).fill("Teste");
  await admin.getByRole("button", { name: "Salvar quote" }).click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  await member.evaluate(() => window.dispatchEvent(new Event("focus")));
  await member
    .getByText("Persistida entre navegadores", { exact: true })
    .waitFor();
  // Manual movies return no TMDB ID; both dates and metadata must remain editable.
  await admin.goto(origin + "/cinergb");
  await admin
    .getByRole("button", { name: "Adicionar sessão", exact: true })
    .click();
  await admin
    .getByLabel("Título", { exact: true })
    .fill("Sessão sem data — regressão");
  await admin.getByLabel("Gênero", { exact: true }).fill("Drama");
  await admin.getByLabel("Situação").selectOption("past");
  await admin
    .getByRole("button", { name: "Salvar sessão", exact: true })
    .click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  await admin.getByText("Data não informada", { exact: true }).waitFor();
  await admin
    .getByRole("button", {
      name: "Editar Sessão sem data — regressão",
      exact: true,
    })
    .click();
  await admin
    .getByLabel("Título", { exact: true })
    .fill("Sessão corrigida — regressão");
  await admin
    .getByLabel("Data e hora da sessão", { exact: true })
    .fill("2026-09-20T20:00");
  await admin
    .getByRole("button", { name: "Salvar sessão", exact: true })
    .click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  await admin.reload();
  await admin
    .getByRole("button", {
      name: "Editar Sessão corrigida — regressão",
      exact: true,
    })
    .click();
  assert.equal(
    await admin
      .getByLabel("Data e hora da sessão", { exact: true })
      .inputValue(),
    "2026-09-20T20:00",
  );
  await admin.getByLabel("Situação").selectOption("upcoming");
  await admin.getByLabel("Data e hora da sessão", { exact: true }).fill("");
  await admin
    .getByRole("button", { name: "Salvar sessão", exact: true })
    .click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  await admin
    .getByRole("button", {
      name: "Editar Sessão corrigida — regressão",
      exact: true,
    })
    .click();
  await admin
    .getByLabel("Data e hora da sessão", { exact: true })
    .fill("2026-10-10T20:00");
  await admin
    .getByRole("button", { name: "Salvar sessão", exact: true })
    .click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  await member.goto(origin + "/tasks");
  await member
    .getByRole("button", { name: "Assumir tarefa", exact: true })
    .click();
  await member
    .getByRole("button", { name: "Concluir: Limpar bancada" })
    .waitFor();
  await member
    .getByRole("button", { name: "Devolver para tarefas a fazer" })
    .click();
  await member
    .getByRole("button", { name: "Assumir tarefa", exact: true })
    .click();
  await member
    .getByRole("button", { name: "Concluir: Limpar bancada" })
    .click();
  await member.getByLabel("Tempo gasto (minutos)").fill("17");
  await member.getByRole("button", { name: "Registrar conclusão" }).click();
  await member.getByRole("dialog").waitFor({ state: "hidden" });
  await admin.goto(origin + "/tasks");
  await admin.getByRole("button", { name: /Mostrar concluídas/ }).click();
  await admin.getByRole("heading", { name: "Limpar bancada" }).waitFor();
  assert.equal(
    await admin.getByLabel(/Peso de Limpar bancada/).inputValue(),
    "17",
  );
  await admin
    .getByRole("button", { name: "Voltar para tarefas a fazer" })
    .click();
  await admin
    .getByRole("button", { name: "Reabrir tarefa", exact: true })
    .click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  const pool = admin.getByRole("region", {
    name: "Tarefas a fazer",
    exact: true,
  });
  await pool.getByRole("article", { name: "Limpar bancada" }).waitFor();
  await admin.getByRole("button", { name: "Ocultar tarefas a fazer" }).click();
  assert.equal(
    await pool.getByRole("article", { name: "Limpar bancada" }).isVisible(),
    false,
  );
  await admin.getByRole("button", { name: "Mostrar tarefas a fazer" }).click();
  await pool.getByRole("article", { name: "Limpar bancada" }).waitFor();
  assert.equal(
    await prisma.taskCompletion.count(),
    1,
    "reopening retains history",
  );
  await member.reload();
  await member
    .getByRole("button", { name: "Assumir tarefa", exact: true })
    .waitFor();
  await member.goto(origin + "/cameras");
  await member.getByRole("button", { name: "Visualizar Entrada" }).waitFor();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    source.clients.size,
    0,
    "disabled cameras must have no upstream connection",
  );
  peak = 0;
  await member.getByRole("button", { name: "Visualizar Entrada" }).click();
  await member.waitForFunction(() =>
    Array.from(document.querySelectorAll("video")).some(
      (v) => v.currentTime > 0 && v.videoWidth === 320,
    ),
  );
  assert.equal(source.clients.size, 1);
  await member.getByRole("button", { name: "Ampliar câmera" }).first().click();
  await member.getByRole("dialog").locator("video").waitFor();
  await member.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>(
      '[role="dialog"] video',
    );
    return video && video.currentTime > 0;
  });
  assert.equal(
    source.clients.size,
    1,
    "expanded playback must suspend its grid player",
  );
  await member.keyboard.press("Escape");
  await member.getByRole("dialog").waitFor({ state: "hidden" });
  await member.getByRole("button", { name: "Visualizar Entrada" }).click();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(source.clients.size, 0);
  await member.getByRole("button", { name: "Visualizar Entrada" }).click();
  await member.waitForFunction(() => !!document.querySelector("video.loaded"));
  await member.getByRole("button", { name: "Sair", exact: true }).click();
  await member
    .getByRole("link", { name: "Entre para ver as câmeras" })
    .waitFor();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(source.clients.size, 0);
  for (const width of [390, 768, 1440]) {
    await admin.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/tasks",
      "/quotes",
      "/cinergb",
      "/admin",
      "/admin/import",
      "/cameras",
    ]) {
      await admin.goto(origin + path);
      await admin.getByRole("button", { name: "Sair", exact: true }).waitFor();
      assert.equal(
        await admin.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        "Horizontal overflow: " + path + " at " + width,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "passed",
      checks: [
        "two-browser persistence",
        "claim/return/complete",
        "completion attribution and weight",
        "real fMP4 MSE playback through authenticated proxy",
        "disabled/expanded/logout cleanup",
        "phone/tablet/desktop routes",
      ],
      peakConnections: peak,
    }),
  );
} finally {
  await browser?.close();
  for (const client of wsServer?.clients || []) client.terminate();
  wsServer?.close();
  for (const client of source.clients) client.terminate();
  await new Promise<void>((r) => source.close(() => r()));
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await database?.$disconnect();
  await pg.stop().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
