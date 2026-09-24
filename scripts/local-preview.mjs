// Persistent, loopback-only preview. Test accounts are created only with --setup.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import EmbeddedPostgres from "embedded-postgres";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const local = resolve(".local");
mkdirSync(local, { recursive: true, mode: 0o700 });
const settingsPath = resolve(local, "preview.json");
if (!existsSync(settingsPath))
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        databasePassword: randomBytes(24).toString("hex"),
        authSecret: randomBytes(32).toString("hex"),
        tmdbKeyFile: resolve("../../TMDB/api_key.txt"),
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const key = readFileSync(settings.tmdbKeyFile, "utf8").trim();
if (!/^[a-f0-9]{32}$/i.test(key))
  throw new Error("The TMDB API key file should contain only the v3 API key.");
Object.assign(process.env, {
  NODE_ENV: "development",
  PORT: "3001",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: `postgresql://postgres:${settings.databasePassword}@127.0.0.1:55438/reprgb_preview`,
  BETTER_AUTH_SECRET: settings.authSecret,
  TMDB_API_KEY: key,
  FRIGATE_CAMERAS: "[]",
  TRUST_PROXY_HOPS: "0",
});
for (const name of [
  "FRIGATE_URL",
  "FRIGATE_AUTH_MODE",
  "FRIGATE_USERNAME",
  "FRIGATE_PASSWORD",
  "FRIGATE_CA_FILE",
])
  delete process.env[name];
const pg = new EmbeddedPostgres({
  databaseDir: resolve(local, "postgres"),
  user: "postgres",
  password: settings.databasePassword,
  port: 55438,
  persistent: true,
  authMethod: "scram-sha-256",
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
let server,
  streams,
  vite,
  prisma,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await vite?.close();
  for (const client of streams?.clients || []) client.terminate();
  streams?.close();
  if (server) await new Promise((r) => server.close(r));
  await prisma?.$disconnect();
  await pg.stop().catch(() => {});
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  if (!existsSync(resolve(local, "postgres/PG_VERSION"))) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient("postgres");
  await client.connect();
  const found = await client.query(
    "SELECT 1 FROM pg_database WHERE datname='reprgb_preview'",
  );
  await client.end();
  if (!found.rowCount) await pg.createDatabase("reprgb_preview");
  for (const args of [
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    ["node_modules/typescript/bin/tsc"],
  ])
    execFileSync(process.execPath, args, { env: process.env, stdio: "pipe" });
  ({ prisma } = await import("../dist/PrismaClient.js"));
  const { createApp } = await import("../dist/app.js");
  const { attachCameras } = await import("../dist/modules/cameras.js");
  server = createServer(createApp());
  streams = attachCameras(server);
  await new Promise((r, reject) => {
    server.once("error", reject);
    server.listen(3001, "127.0.0.1", r);
  });
  const { createServer: createVite } =
    await import("../../reprgb-site/node_modules/vite/dist/node/index.js");
  vite = await createVite({
    root: resolve("../reprgb-site"),
    configFile: resolve("../reprgb-site/vite.config.ts"),
    server: { host: "127.0.0.1", port: 3000, strictPort: true, open: false },
  });
  await vite.listen();
  if (process.argv.includes("--setup")) {
    if (await prisma.user.count())
      throw new Error("Preview already has accounts; restart without --setup.");
    const { hashPassword } = await import("better-auth/crypto");
    const admin = {
      email: "admin@reprgb.test",
      password: randomBytes(15).toString("base64url"),
    };
    const resident = {
      email: "morador@reprgb.test",
      password: randomBytes(15).toString("base64url"),
    };
    writeFileSync(
      resolve(local, "accounts.json"),
      JSON.stringify({ admin, resident }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        name: "Administrador Teste",
        email: admin.email,
        role: "admin",
        accounts: {
          create: {
            id: randomUUID(),
            accountId: id,
            providerId: "credential",
            password: await hashPassword(admin.password),
          },
        },
      },
    });
    let cookie = "";
    async function api(path, body) {
      const response = await fetch("http://127.0.0.1:3001" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok)
        throw new Error(
          `Preview setup request failed: ${path.split("?")[0]} (${response.status})`,
        );
      return { data: await response.json(), response };
    }
    const login = await api("/api/auth/sign-in/email", admin);
    cookie = login.response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const person = (
      await api("/api/v1/residents", {
        name: "Morador Teste",
        color: "#00ff00",
      })
    ).data;
    const invitation = (
      await api("/api/v1/invitations", {
        email: resident.email,
        residentId: person.id,
      })
    ).data;
    await api("/api/v1/register", {
      ...resident,
      name: "Morador Teste",
      token: new URL(invitation.url).searchParams.get("invite"),
    });
    const { houseDate, dayNumber } = await import("../dist/core/schedule.js");
    const today = houseDate();
    await api("/api/v1/tasks", {
      name: "Testar conclusão e registrar minutos",
      area: "Cozinha",
      assigneeId: person.id,
      recurrence: { kind: "weekly", weekdays: [dayNumber(today)] },
      dueDate: today,
    });
    await api("/api/v1/tasks", {
      name: "Assumir e devolver esta tarefa de teste",
      area: "Casa toda",
      assigneeId: null,
      recurrence: { kind: "once" },
      dueDate: today,
    });
    await api("/api/v1/quotes", {
      text: "Esta é uma quote de teste. Você pode editar ou remover pelo administrador.",
      author: "REP RGB",
    });
    try {
      const movies = (await api("/api/v1/movies/search?q=Interestelar")).data;
      const match = movies.find((m) => m.tmdbId === 157336) || movies[0];
      if (match) {
        const movie = (await api("/api/v1/movies/tmdb/" + match.tmdbId)).data;
        await api("/api/v1/screenings", { ...movie, status: "upcoming" });
        console.log("TMDB verified; an upcoming screening was saved.");
      }
    } catch {
      console.log("Preview ready; TMDB verification needs another attempt.");
    }
    await api("/api/auth/sign-out", {});
    console.log(
      "Test accounts saved in .local/accounts.json (not tracked by Git).",
    );
  }
  console.log(
    "REP RGB ready: http://localhost:3000 — database persists in .local/postgres.",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Preview startup failed",
  );
  await stop();
  process.exitCode = 1;
}
