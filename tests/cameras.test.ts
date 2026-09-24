import { beforeAll, afterAll, it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { hashPassword } from "better-auth/crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { attachCameras } from "../src/modules/cameras.js";
import { config } from "../src/config.js";
import { prisma } from "../src/PrismaClient.js";
import { revocations } from "../src/auth.js";
const app = createApp(),
  server = createServer(app),
  upstream = createServer();
const source = new WebSocketServer({ noServer: true });
const proxy = attachCameras(server);
let base: string,
  cookie: string,
  userId: string,
  loginCount = 0,
  connectionCount = 0,
  lastAuthorization: string | undefined,
  loginFails = false;
const controls: any[] = [];
const clients = new Set<WebSocket>();
beforeAll(async () => {
  userId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: "camera@test.com",
      name: "Viewer",
      role: "resident",
      accounts: {
        create: {
          id: randomUUID(),
          providerId: "credential",
          accountId: userId,
          password: await hashPassword("camera-test-password"),
        },
      },
    },
  });
  const login = await request(app)
    .post("/api/auth/sign-in/email")
    .send({ email: "camera@test.com", password: "camera-test-password" });
  expect(login.status, login.text).toBe(200);
  cookie = (login.headers["set-cookie"] as unknown as string[])
    .map((c) => c.split(";")[0])
    .join("; ");
  upstream.on("request", (req, res) => {
    if (req.url !== "/api/login") {
      res.writeHead(404).end();
      return;
    }
    loginCount++;
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      expect(JSON.parse(data)).toEqual({
        user: "viewer",
        password: "test-upstream-password",
      });
      if (loginFails) {
        res.writeHead(401).end();
        return;
      }
      const jwt =
        "x." +
        Buffer.from(
          JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 2 }),
        ).toString("base64url") +
        ".x";
      res.setHeader(
        "Set-Cookie",
        "frigate_token=" + jwt + "; HttpOnly; Path=/",
      );
      res.end("{}");
    });
  });
  upstream.on("upgrade", (req, socket, head) => {
    lastAuthorization = req.headers.authorization;
    expect(req.url).toBe("/live/mse/api/ws?src=front");
    source.handleUpgrade(req, socket, head, (ws) => {
      connectionCount++;
      source.emit("connection", ws);
    });
  });
  source.on("connection", (ws) => {
    ws.on("message", (data, binary) => {
      expect(binary).toBe(false);
      const message = JSON.parse(data.toString());
      controls.push(message);
      ws.send(
        JSON.stringify({
          type: "mse",
          value: 'video/mp4; codecs="avc1.640029"',
        }),
      );
      ws.send(Buffer.from([1, 2, 3, 4]));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(55440, "127.0.0.1", resolve),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "ws://127.0.0.1:" + (server.address() as any).port;
});
afterAll(async () => {
  for (const ws of clients) ws.terminate();
  for (const ws of source.clients) ws.terminate();
  for (const ws of proxy.clients) ws.terminate();
  source.close();
  proxy.close();
  await Promise.all([
    new Promise<void>((resolve) => upstream.close(() => resolve())),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  await prisma.$disconnect();
});
function connect(
  path = "/api/v1/cameras/entrada/mse",
  origin = "http://localhost:3000",
  authenticated = true,
) {
  const ws = new WebSocket(base + path, {
    origin,
    headers: authenticated ? { Cookie: cookie } : {},
  });
  ws.on("error", () => {});
  clients.add(ws);
  return ws;
}
async function rejected(ws: WebSocket) {
  return new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode!);
      ws.terminate();
    });
  });
}
async function stream() {
  const ws = connect();
  await once(ws, "open");
  const messages: unknown[] = [];
  const received = new Promise<void>((resolve) =>
    ws.on("message", (data, binary) => {
      messages.push(
        binary ? Array.from(data as Buffer) : JSON.parse(data.toString()),
      );
      if (messages.length === 2) resolve();
    }),
  );
  ws.send(JSON.stringify({ type: "mse", value: "avc1.640029" }));
  await received;
  return { ws, messages };
}
it("rejects anonymous, foreign-origin, unknown IDs and arbitrary query destinations before opening upstream", async () => {
  const before = connectionCount;
  const results = await Promise.all(
    [
      connect(undefined, undefined, false),
      connect(undefined, "https://evil.example"),
      connect("/api/v1/cameras/unknown/mse"),
      connect("/api/v1/cameras/entrada/mse?src=secret"),
    ].map(rejected),
  );
  expect(results).toEqual([403, 403, 403, 403]);
  expect(connectionCount).toBe(before);
});
it("relays negotiation and binary media only to the configured stream in internal mode", async () => {
  const { ws, messages } = await stream();
  expect(lastAuthorization).toBeUndefined();
  expect(loginCount).toBe(0);
  expect(controls.at(-1)).toEqual({ type: "mse", value: "avc1.640029" });
  expect(messages[1]).toEqual([1, 2, 3, 4]);
  ws.close();
  await once(ws, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(source.clients.size).toBe(0);
});
it("rejects management control messages", async () => {
  const ws = connect();
  await once(ws, "open");
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "config", value: "recording=false" }));
  expect((await closed)[0]).toBe(1008);
});
it("authenticates server-side and reauthenticates expired upstream tokens", async () => {
  config.FRIGATE_AUTH_MODE = "account";
  config.FRIGATE_USERNAME = "viewer";
  config.FRIGATE_PASSWORD = "test-upstream-password";
  const first = await stream();
  expect(lastAuthorization).toMatch(/^Bearer x\./);
  first.ws.close();
  await once(first.ws, "close");
  const count = loginCount;
  const second = await stream();
  expect(loginCount).toBe(count + 1);
  second.ws.close();
  await once(second.ws, "close");
});
it("never falls back to internal access when upstream login fails", async () => {
  loginFails = true;
  const count = connectionCount;
  expect(await rejected(connect())).toBe(403);
  expect(connectionCount).toBe(count);
  loginFails = false;
});
it("closes open streams on account revocation", async () => {
  config.FRIGATE_AUTH_MODE = "internal";
  const { ws } = await stream();
  const closed = once(ws, "close");
  revocations.emit("user", userId);
  expect((await closed)[0]).toBe(4001);
});
it("reports upstream disconnects and releases both connections", async () => {
  const { ws } = await stream();
  const closed = once(ws, "close");
  for (const upstream of source.clients) upstream.close();
  expect((await closed)[0]).toBe(1011);
});

it("redacts upstream error details before forwarding them", async () => {
  const { ws } = await stream();
  const message = once(ws, "message");
  for (const upstream of source.clients)
    upstream.send(
      JSON.stringify({
        type: "error",
        value: "rtsp://private-user:private-password@camera.internal",
      }),
    );
  expect(JSON.parse((await message)[0].toString())).toEqual({
    type: "error",
    value: "Stream unavailable",
  });
  ws.close();
  await once(ws, "close");
});
