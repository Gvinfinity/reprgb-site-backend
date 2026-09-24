import { Router } from "express";
import { readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { cameras, config, origin } from "../config.js";
import { requireUser, getActor, revocations } from "../auth.js";
import { fail, log } from "../core/http.js";
export const camerasRouter = Router();
camerasRouter.get("/", (_req, res) => {
  requireUser(res.locals.actor);
  res.json(
    cameras.map(({ stream: _stream, ...camera }) => ({
      ...camera,
      status: config.FRIGATE_URL ? "online" : "offline",
    })),
  );
});
const ca = config.FRIGATE_CA_FILE
  ? readFileSync(config.FRIGATE_CA_FILE)
  : undefined;
let token: { value: string; expires: number } | null = null;
let loggingIn: Promise<string | undefined> | null = null;
function loginRequest(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL("api/login", config.FRIGATE_URL!.replace(/\/?$/, "/"));
    const body = JSON.stringify({
      user: config.FRIGATE_USERNAME,
      password: config.FRIGATE_PASSWORD,
    });
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        ...(url.protocol === "https:" ? { ca } : {}),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        const cookie = response.headers["set-cookie"]?.find((c) =>
          c.startsWith("frigate_token="),
        );
        const value = cookie?.split(";")[0].slice("frigate_token=".length);
        if (response.statusCode !== 200 || !value) {
          reject(new Error("Frigate authentication failed"));
          return;
        }
        let expires = Date.now() + 5 * 60000;
        try {
          const payload = JSON.parse(
            Buffer.from(value.split(".")[1], "base64url").toString(),
          );
          if (typeof payload.exp === "number")
            expires = payload.exp * 1000 - 30000;
        } catch {}
        token = { value, expires };
        resolve(value);
      },
    );
    request.setTimeout(8000, () =>
      request.destroy(new Error("Frigate login timeout")),
    );
    request.on("error", reject);
    request.end(body);
  });
}
async function upstreamToken() {
  if (config.FRIGATE_AUTH_MODE === "internal") return undefined;
  if (token && token.expires > Date.now()) return token.value;
  if (!loggingIn)
    loggingIn = loginRequest().finally(() => {
      loggingIn = null;
    });
  return loggingIn;
}
export function attachCameras(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", origin);
      const match = /^\/api\/v1\/cameras\/([a-z0-9_-]+)\/mse$/.exec(
        url.pathname,
      );
      if (!match || url.search || request.headers.origin !== origin)
        throw new Error("Rejected upgrade");
      const actor = await getActor(request.headers);
      const camera = cameras.find((c) => c.id === match[1]);
      if (!actor || !camera || !config.FRIGATE_URL)
        throw new Error("Unauthorized or unavailable");
      const upstreamAuth = await upstreamToken();
      if (socket.destroyed) return;
      if (!(await getActor(request.headers)))
        throw new Error("Session revoked during connection");
      wss.handleUpgrade(request, socket, head, (client) => {
        const upstreamUrl = new URL(
          "live/mse/api/ws",
          config.FRIGATE_URL!.replace(/\/?$/, "/"),
        );
        upstreamUrl.searchParams.set("src", camera.stream);
        upstreamUrl.protocol =
          upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
        const upstream = new WebSocket(upstreamUrl, {
          ca,
          headers: upstreamAuth
            ? { Authorization: "Bearer " + upstreamAuth }
            : {},
          handshakeTimeout: 8000,
          maxPayload: 8 * 1024 * 1024,
        });
        let pending: string | null = null,
          closed = false;
        const finish = (code = 1000, reason = "Closed") => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          revocations.off("user", revoked);
          if (upstream.readyState === WebSocket.CONNECTING)
            upstream.terminate();
          else upstream.close();
          client.close(code, reason);
        };
        const revoked = (id: string) => {
          if (id === actor.id) finish(4001, "Session revoked");
        };
        revocations.on("user", revoked);
        const timer = setInterval(() => {
          void getActor(request.headers)
            .then((current) => {
              if (!current) finish(4001, "Session expired");
            })
            .catch(() => finish(1011, "Session unavailable"));
        }, 15000);
        client.on("message", (data, binary) => {
          if (binary) return finish(1008, "Invalid control");
          try {
            const message = JSON.parse(data.toString());
            if (
              message.type !== "mse" ||
              typeof message.value !== "string" ||
              message.value.length > 2000
            )
              return finish(1008, "Invalid control");
            const text = JSON.stringify({ type: "mse", value: message.value });
            if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
            else pending = text;
          } catch {
            finish(1008, "Invalid control");
          }
        });
        upstream.on("open", () => {
          if (pending) {
            upstream.send(pending);
            pending = null;
          }
        });
        upstream.on("message", (data, binary) => {
          if (client.bufferedAmount > 8 * 1024 * 1024)
            return finish(1013, "Slow connection");
          if (client.readyState !== WebSocket.OPEN) return;
          if (binary) {
            client.send(data, { binary: true });
            return;
          }
          // Upstream errors may contain camera URLs. Never forward their details.
          try {
            const message = JSON.parse(data.toString());
            if (message.type === "error") {
              client.send(
                JSON.stringify({ type: "error", value: "Stream unavailable" }),
              );
              return;
            }
            if (
              message.type === "mse" &&
              typeof message.value === "string" &&
              message.value.length <= 512 &&
              /^(video|audio)\/mp4;\s*codecs="[a-zA-Z0-9., _-]+"$/.test(
                message.value,
              )
            ) {
              client.send(
                JSON.stringify({ type: "mse", value: message.value }),
              );
            } else finish(1011, "Invalid stream response");
          } catch {
            finish(1011, "Invalid stream response");
          }
        });
        upstream.on("unexpected-response", (_req, response) => {
          if (response.statusCode === 401) token = null;
          response.resume();
          finish(1011, "Frigate unavailable");
        });
        upstream.on("error", () => finish(1011, "Frigate unavailable"));
        upstream.on("close", () => finish(1011, "Stream ended"));
        client.on("error", () => finish());
        client.on("close", () => finish());
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  return wss;
}
