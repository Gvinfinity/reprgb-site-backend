import { inject } from "vitest";
process.env.DATABASE_URL = inject("databaseUrl" as never) as string;
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET =
  "test-secret-for-reprgb-only-at-least-32-characters";
process.env.NODE_ENV = "test";
process.env.FRIGATE_URL = "http://127.0.0.1:55440";
process.env.FRIGATE_AUTH_MODE = "internal";
process.env.FRIGATE_CAMERAS = JSON.stringify([
  { id: "entrada", name: "Entrada", location: "Entrada", stream: "front" },
]);
process.env.TMDB_API_KEY = "test-key";
