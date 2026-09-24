import { describe, it, expect } from "vitest";
import {
  houseDate,
  weekBounds,
  nextOccurrence,
  validRecurrence,
} from "../src/core/schedule.js";
describe("household fixed calendar schedules", () => {
  it("uses Sao Paulo midnight and Monday to Sunday weeks", () => {
    expect(houseDate(new Date("2026-09-21T02:59:59Z"))).toBe("2026-09-20");
    expect(weekBounds("2026-09-20")).toEqual(["2026-09-14", "2026-09-20"]);
    expect(weekBounds("2026-09-21")).toEqual(["2026-09-21", "2026-09-27"]);
  });
  it("advances multiple weekdays without a backlog", () => {
    const task = {
      dueDate: "2026-09-07",
      recurrence: { kind: "weekly" as const, weekdays: [1, 5] },
    };
    expect(nextOccurrence(task, "2026-09-24")).toBe("2026-09-25");
    expect(nextOccurrence(task, "2026-09-25")).toBe("2026-09-28");
  });
  it("keeps fortnightly anchors across late completion", () => {
    const task = {
      dueDate: "2026-09-01",
      recurrence: { kind: "fortnightly" as const, anchorDate: "2026-09-01" },
    };
    expect(nextOccurrence(task, "2026-09-23")).toBe("2026-09-29");
    expect(validRecurrence(task.recurrence, "2026-09-30")).toBe(false);
  });
  it("clamps month end and preserves original day after February", () => {
    const task = {
      dueDate: "2028-01-31",
      recurrence: { kind: "monthly" as const, dayOfMonth: 31 },
    };
    expect(nextOccurrence(task, "2028-01-31")).toBe("2028-02-29");
    expect(nextOccurrence(task, "2028-02-29")).toBe("2028-03-31");
    expect(nextOccurrence(task, "2028-12-31")).toBe("2029-01-31");
  });
});

it("supports exact day intervals without replacing them with calendar months", () => {
  const task = {
    dueDate: "2026-01-31",
    recurrence: {
      kind: "interval" as const,
      everyDays: 30,
      anchorDate: "2026-01-31",
    },
  };
  expect(nextOccurrence(task, "2026-01-31")).toBe("2026-03-02");
  expect(nextOccurrence(task, "2026-05-03")).toBe("2026-05-31");
  expect(validRecurrence(task.recurrence, "2026-03-02")).toBe(true);
  expect(validRecurrence(task.recurrence, "2026-02-28")).toBe(false);
  expect(
    validRecurrence({ ...task.recurrence, everyDays: 0 }, task.dueDate),
  ).toBe(false);
  expect(
    nextOccurrence(
      { ...task, recurrence: { ...task.recurrence, everyDays: 84 } },
      "2026-01-31",
    ),
  ).toBe("2026-04-25");
});
