import { createHash } from "node:crypto";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
export const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const dbDate = (s: string) => new Date(s + "T00:00:00Z");
export function log(event: string, data: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === "test") return;
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), event, ...data }) + "\n",
  );
}
