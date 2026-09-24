import type { TaskRecurrence } from "./schemas.js";
type HouseTask = { recurrence: TaskRecurrence; dueDate: string };
export const HOUSE_TIMEZONE = "America/Sao_Paulo";
export const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
export function houseDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HOUSE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function dayNumber(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
}
export function weekBounds(today: string): [string, string] {
  const start = addDays(today, 1 - dayNumber(today));
  return [start, addDays(start, 6)];
}
export function nextScheduledDate(after: string, days: number[]): string {
  for (let offset = 1; offset <= 7; offset++) {
    const date = addDays(after, offset);
    if (days.includes(dayNumber(date))) return date;
  }
  throw new Error("A tarefa precisa de pelo menos um dia da semana.");
}
export function validCalendarDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validDuration(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}
export function validRecurrence(
  value: TaskRecurrence,
  dueDate: string,
): boolean {
  if (!value || !validCalendarDate(dueDate)) return false;
  switch (value.kind) {
    case "once":
      return true;
    case "weekly":
      return (
        Array.isArray(value.weekdays) &&
        value.weekdays.length > 0 &&
        value.weekdays.every(
          (day) => Number.isInteger(day) && day >= 1 && day <= 7,
        ) &&
        value.weekdays.includes(dayNumber(dueDate))
      );
    case "interval":
      return (
        Number.isInteger(value.everyDays) &&
        value.everyDays >= 1 &&
        value.everyDays <= 36500 &&
        validCalendarDate(value.anchorDate) &&
        dueDate >= value.anchorDate &&
        Math.round(
          (Date.parse(dueDate) - Date.parse(value.anchorDate)) / 86400000,
        ) %
          value.everyDays ===
          0
      );
    case "fortnightly":
      return (
        validCalendarDate(value.anchorDate) &&
        dueDate >= value.anchorDate &&
        Math.round(
          (Date.parse(dueDate) - Date.parse(value.anchorDate)) / 86400000,
        ) %
          14 ===
          0
      );
    case "monthly": {
      if (
        !Number.isInteger(value.dayOfMonth) ||
        value.dayOfMonth < 1 ||
        value.dayOfMonth > 31
      )
        return false;
      const date = new Date(`${dueDate}T12:00:00Z`);
      const last = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
      ).getUTCDate();
      return date.getUTCDate() === Math.min(value.dayOfMonth, last);
    }
    default:
      return false;
  }
}
export function recurrenceLabel(recurrence: TaskRecurrence): string {
  switch (recurrence.kind) {
    case "once":
      return "Única";
    case "weekly":
      return recurrence.weekdays.map((day) => weekdays[day - 1]).join(", ");
    case "interval":
      return `A cada ${recurrence.everyDays} ${recurrence.everyDays === 1 ? "dia" : "dias"}`;
    case "fortnightly":
      return "A cada 2 semanas";
    case "monthly":
      return `Mensal · dia ${recurrence.dayOfMonth}`;
  }
}
export function nextOccurrence(task: HouseTask, after: string): string {
  const recurrence = task.recurrence;
  if (recurrence.kind === "weekly")
    return nextScheduledDate(after, recurrence.weekdays);
  if (recurrence.kind === "interval") {
    const elapsed = Math.round(
      (Date.parse(after) - Date.parse(recurrence.anchorDate)) / 86400000,
    );
    return addDays(
      recurrence.anchorDate,
      Math.max(0, Math.floor(elapsed / recurrence.everyDays) + 1) *
        recurrence.everyDays,
    );
  }
  if (recurrence.kind === "fortnightly") {
    const elapsedDays = Math.round(
      (Date.parse(after) - Date.parse(recurrence.anchorDate)) / 86400000,
    );
    return addDays(
      recurrence.anchorDate,
      (Math.floor(elapsedDays / 14) + 1) * 14,
    );
  }
  if (recurrence.kind === "monthly") {
    const date = new Date(`${after}T12:00:00Z`);
    for (let offset = 0; offset < 2; offset++) {
      const month = date.getUTCMonth() + offset,
        year = date.getUTCFullYear();
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const candidate = new Date(
        Date.UTC(year, month, Math.min(recurrence.dayOfMonth, last), 12),
      )
        .toISOString()
        .slice(0, 10);
      if (candidate > after) return candidate;
    }
  }
  return task.dueDate; // One-off tasks retain their original deadline in history.
}
