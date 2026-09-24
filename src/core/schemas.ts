import { z } from "zod";
import { validCalendarDate, validRecurrence } from "./schedule.js";
export const date = z.string().refine(validCalendarDate, "Data inválida");
export const recurrence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once") }),
  z.object({
    kind: z.literal("interval"),
    everyDays: z.number().int().min(1).max(36500),
    anchorDate: date,
  }),
  z.object({
    kind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }),
  z.object({ kind: z.literal("fortnightly"), anchorDate: date }),
  z.object({
    kind: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
]);
export type TaskRecurrence = z.infer<typeof recurrence>;
export const areas = [
  "Casa toda",
  "Cozinha",
  "Sala de estar",
  "Banheiros",
  "Quintal",
  "Entrada",
  "Corredor",
  "Outro",
  "Garagem",
  "Área de serviço",
  "Sala de jantar",
] as const;
export const areaKeys = [
  "HOUSE",
  "KITCHEN",
  "LIVING_ROOM",
  "BATHROOMS",
  "YARD",
  "ENTRANCE",
  "HALLWAY",
  "OTHER",
  "GARAGE",
  "LAUNDRY",
  "DINING_ROOM",
] as const;
export const taskInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    weightHours: z
      .number()
      .finite()
      .nonnegative()
      .max(10000)
      .nullable()
      .optional(),
    area: z.enum(areas),
    assigneeId: z.string().uuid().nullable(),
    recurrence,
    dueDate: date,
  })
  .refine(
    (t) => validRecurrence(t.recurrence, t.dueDate),
    "Programação inválida",
  );
export const quoteInput = z.object({
  text: z.string().trim().min(1).max(3000),
  author: z.string().trim().min(1).max(120),
  date: date.optional(),
});
export const minutes = z.number().int().positive().max(2147483647).nullable();
export const movieInput = z.object({
  title: z.string().trim().min(1).max(160),
  year: z.number().int().min(1888).max(9999),
  genre: z.string().trim().min(1).max(100),
  duration: z.number().int().positive(),
  synopsis: z.string().max(3000),
  posterUrl: z
    .string()
    .refine(
      (s) => /^https?:\/\//.test(s) || /^\/(?!\/)/.test(s),
      "URL inválida",
    )
    .optional(),
});
export const screeningInput = movieInput.extend({
  movieId: z.string().optional(),
  tmdbId: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((value) => value ?? undefined),
  status: z.enum(["past", "upcoming"]),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
});
export const version = z.number().int().nonnegative();
