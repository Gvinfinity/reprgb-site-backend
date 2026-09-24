import { createServer } from "node:http";
import { createApp } from "./app.js";
import { attachCameras } from "./modules/cameras.js";
import { config } from "./config.js";
import { prisma } from "./PrismaClient.js";
import { log } from "./core/http.js";
const server = createServer(createApp());
const cameras = attachCameras(server);
server.listen(config.PORT, "0.0.0.0", () =>
  log("listening", { port: config.PORT }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const client of cameras.clients) client.close(1001);
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
