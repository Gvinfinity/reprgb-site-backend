import "dotenv/config";
import { z } from "zod";
const camera = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  location: z.string(),
  stream: z.string().min(1),
});
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32),
  TMDB_API_KEY: z.string().optional(),
  FRIGATE_URL: z.string().url().optional(),
  FRIGATE_AUTH_MODE: z.enum(["account", "internal"]).optional(),
  FRIGATE_USERNAME: z.string().optional(),
  FRIGATE_PASSWORD: z.string().optional(),
  FRIGATE_CA_FILE: z.string().optional(),
  FRIGATE_CAMERAS: z.string().default("[]"),
});
export const config = schema.parse(process.env);
export const cameras = z
  .array(camera)
  .max(16)
  .parse(JSON.parse(config.FRIGATE_CAMERAS));
if (new Set(cameras.map((c) => c.id)).size !== cameras.length)
  throw new Error("Duplicate camera IDs");
if (config.FRIGATE_URL && !config.FRIGATE_AUTH_MODE)
  throw new Error("FRIGATE_AUTH_MODE must be explicit");
if (
  config.FRIGATE_AUTH_MODE === "account" &&
  (!config.FRIGATE_USERNAME || !config.FRIGATE_PASSWORD)
)
  throw new Error("Frigate credentials required");
export const origin = new URL(config.APP_ORIGIN).origin;
if (!["http:", "https:"].includes(new URL(config.APP_ORIGIN).protocol))
  throw new Error("APP_ORIGIN must use HTTP(S)");
if (config.FRIGATE_URL) {
  const url = new URL(config.FRIGATE_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "FRIGATE_URL must be an HTTP(S) base URL without credentials or query",
    );
}
