import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { taskImportInput } from "../modules/taskImports.js";
import {
  taskInput,
  quoteInput,
  screeningInput,
  minutes,
  version,
} from "../core/schemas.js";
extendZodWithOpenApi(z);
const registry = new OpenAPIRegistry();
registry.registerComponent("securitySchemes", "session", {
  type: "apiKey",
  in: "cookie",
  name: "better-auth.session_token",
  description:
    "Better Auth HttpOnly session cookie; HTTPS uses the __Secure- prefix.",
});
const error = z.object({ error: z.string(), requestId: z.string().optional() });
const common = {
  400: {
    description: "Invalid input",
    content: { "application/json": { schema: error } },
  },
  401: { description: "Login required" },
  403: { description: "Forbidden" },
  409: { description: "Version conflict or duplicate" },
  500: { description: "Server failure" },
};
type Method = "get" | "post" | "patch" | "put" | "delete";
function route(
  method: Method,
  path: string,
  summary: string,
  body?: z.ZodType,
  access = "admin",
  success = 200,
) {
  registry.registerPath({
    method,
    path: "/api/v1" + path,
    summary,
    tags: [path.split("/")[1]],
    security: access === "public" ? [] : [{ session: [] }],
    description: "Access: " + access,
    request: {
      ...(path.includes("{id}")
        ? { params: z.object({ id: z.string() }) }
        : {}),
      ...(body
        ? { body: { content: { "application/json": { schema: body } } } }
        : {}),
    },
    responses: { [success]: { description: "Success" }, ...common },
  });
}
route("get", "/me", "Current account", undefined, "public");
route("get", "/residents", "Public resident display data", undefined, "public");
route(
  "post",
  "/residents",
  "Create a resident",
  z.object({
    name: z.string(),
    color: z.string().optional(),
    active: z.boolean().optional(),
    isHousemate: z.boolean().optional(),
  }),
);
route(
  "patch",
  "/residents/{id}",
  "Edit a resident",
  z.object({
    name: z.string().optional(),
    color: z.string().optional(),
    active: z.boolean().optional(),
    isHousemate: z.boolean().optional(),
  }),
);
route("get", "/accounts", "List accounts");
route(
  "patch",
  "/accounts/{id}",
  "Activate or deactivate account",
  z.object({ active: z.boolean() }),
);
route("post", "/accounts/{id}/revoke", "Revoke sessions");
route("get", "/invitations", "List invitations");
route(
  "post",
  "/invitations",
  "Create seven-day invitation",
  z.object({ email: z.email(), residentId: z.string().uuid() }),
  "admin",
  201,
);
route(
  "post",
  "/register",
  "Redeem invitation",
  z.object({
    token: z.string(),
    name: z.string(),
    email: z.email(),
    password: z.string().min(10).max(128),
  }),
  "public",
  201,
);
route(
  "get",
  "/tasks",
  "Tasks including completion history",
  undefined,
  "public",
);
route("post", "/tasks", "Create task", taskInput, "admin", 201);
route(
  "patch",
  "/tasks/{id}",
  "Edit pending task",
  taskInput.safeExtend({ version }),
);
route(
  "post",
  "/tasks/{id}/archive",
  "Archive task and retain history",
  z.object({ version }),
);
route(
  "patch",
  "/tasks/{id}/assignment",
  "Claim, return or reassign task",
  z.object({ version, assigneeId: z.string().uuid().nullable() }),
  "resident",
);
route(
  "post",
  "/tasks/{id}/completions",
  "Complete task; requires UUID Idempotency-Key header",
  z.object({
    version,
    residentId: z.string().uuid(),
    durationMinutes: minutes,
  }),
  "resident",
);
route(
  "post",
  "/tasks/{id}/reopen",
  "Reopen latest completion, keeping history and original deadline; owner or admin",
  z.object({ version }),
  "resident",
);
route("get", "/tasks/{id}/events", "Administrative task audit log");
route("get", "/completions", "Public completion history", undefined, "public");
route(
  "patch",
  "/completions/{id}",
  "Correct duration; owner or admin",
  z.object({ version, durationMinutes: minutes }),
  "resident",
);
route(
  "get",
  "/quotes",
  "List/search quotes with q query parameter",
  undefined,
  "public",
);
route("post", "/quotes", "Create quote", quoteInput, "admin", 201);
route("put", "/quotes/{id}", "Edit quote", quoteInput);
route("delete", "/quotes/{id}", "Delete quote", undefined, "admin", 204);
registry.registerPath({
  method: "post",
  path: "/api/v1/quote-imports",
  summary: "Store UTF-8 TXT awaiting future parser",
  security: [{ session: [] }],
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.string().openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: {
    202: { description: "Stored or existing import; awaiting_parser" },
    413: { description: "Limit 1 MiB" },
    ...common,
  },
});
route("get", "/quote-imports", "List TXT uploads");
route(
  "get",
  "/quote-imports/{id}",
  "Upload status and first 10,000 characters",
);
route("get", "/movies/search", "TMDB movie search (q)");
route("get", "/movies/tmdb/{id}", "Fetch Portuguese TMDB movie metadata");
route(
  "get",
  "/screenings",
  "Persisted movies and screenings",
  undefined,
  "public",
);
route("post", "/screenings", "Add screening", screeningInput, "admin", 201);
route(
  "put",
  "/screenings/{id}",
  "Edit movie and screening",
  screeningInput.safeExtend({ version }),
);
route(
  "get",
  "/cameras",
  "Configured camera display data",
  undefined,
  "resident",
);
route(
  "get",
  "/cameras/{id}/mse",
  "WebSocket upgrade: session and same Origin required; MSE control JSON and binary media",
  undefined,
  "resident",
  101,
);
for (const action of ["preview", "commit"])
  route(
    "post",
    "/data-imports/" + action,
    "Browser v3 data import " + action,
    z.object({
      snapshot: z.record(z.string(), z.unknown()),
      mapping: z.record(z.string(), z.string().uuid()),
    }),
  );
for (const entity of ["people", "leaderboards"]) {
  route("get", "/" + entity, "Legacy admin listing");
  route("post", "/" + entity, "Legacy admin creation");
  route("put", "/" + entity + "/{id}", "Legacy admin update");
  route("delete", "/" + entity + "/{id}", "Legacy admin deletion");
}
for (const [path, body] of [
  ["sign-in/email", z.object({ email: z.email(), password: z.string() })],
  ["sign-out", z.object({})],
  [
    "change-password",
    z.object({
      currentPassword: z.string(),
      newPassword: z.string().min(10).max(128),
      revokeOtherSessions: z.boolean().optional(),
    }),
  ],
] as const)
  registry.registerPath({
    method: "post",
    path: "/api/auth/" + path,
    tags: ["authentication"],
    summary: path,
    security: path === "sign-in/email" ? [] : [{ session: [] }],
    request: { body: { content: { "application/json": { schema: body } } } },
    responses: {
      200: { description: "Better Auth result; session cookies are HttpOnly" },
      ...common,
    },
  });
registry.registerPath({
  method: "get",
  path: "/api/auth/get-session",
  tags: ["authentication"],
  summary: "Current Better Auth session",
  responses: { 200: { description: "Current session or null" }, ...common },
});
for (const action of ["preview", "commit"])
  route(
    "post",
    "/task-imports/" + action,
    "Import Notion task definitions, exact day intervals and reference weights in hours",
    taskImportInput,
  );
export const openApiDocument = new OpenApiGeneratorV3(
  registry.definitions,
).generateDocument({
  openapi: "3.0.0",
  info: { title: "REP RGB", version: "1.0.0" },
  servers: [{ url: "/" }],
});
