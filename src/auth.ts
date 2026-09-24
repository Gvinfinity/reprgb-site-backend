import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import { prisma } from "./PrismaClient.js";
import { config, origin } from "./config.js";
import { fail } from "./core/http.js";
import { EventEmitter } from "node:events";
export const revocations = new EventEmitter();
revocations.setMaxListeners(0);
export const auth = betterAuth({
  logger: { disabled: true },
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  baseURL: config.APP_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [origin],
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 10,
  },
  session: { cookieCache: { enabled: false } },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "resident", input: false },
      active: { type: "boolean", defaultValue: true, input: false },
      residentId: { type: "string", required: false, input: false },
    },
  },
  advanced: { useSecureCookies: origin.startsWith("https:") },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
          });
          if (!user?.active) return false;
          return { data: session };
        },
      },
    },
  },
});
export type Actor = {
  id: string;
  name: string;
  role: "admin" | "resident";
  residentId: string | null;
};
export async function getActor(
  headers: IncomingHttpHeaders,
): Promise<Actor | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(headers),
    query: { disableCookieCache: true },
  });
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user?.active) return null;
  return {
    id: user.id,
    name: user.name,
    role: user.role === "admin" ? "admin" : "resident",
    residentId: user.residentId,
  };
}
export const requireUser = (actor: Actor | null): Actor =>
  actor || fail(401, "Entre para continuar.");
export const requireAdmin = (actor: Actor | null): Actor => {
  const u = requireUser(actor);
  if (u.role !== "admin") fail(403, "Acesso exclusivo de administradores.");
  return u;
};
