import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const DisplayStyleEnum = z.enum(['BINARY', 'HEX', 'DECIMAL', 'TOKIPONA', 'ZE']);

export const createLeaderboardSchema = z.object({
  semester: z.string().datetime().or(z.date()),
  style: DisplayStyleEnum.optional().default('DECIMAL'),
  personId: z.string().uuid(),
  sleepingMisses: z.array(z.string().datetime().or(z.date())).optional().default([]),
  classMisses: z.array(z.string().datetime().or(z.date())).optional().default([]),
});

export const updateLeaderboardSchema = z.object({
  semester: z.string().datetime().or(z.date()).optional(),
  style: DisplayStyleEnum.optional(),
  personId: z.string().uuid().optional(),
  sleepingMisses: z.array(z.string().datetime().or(z.date())).optional(),
  classMisses: z.array(z.string().datetime().or(z.date())).optional(),
});

export const leaderboardIdSchema = z.object({
  id: z.coerce.number().int().positive().openapi({ param: { name: 'id', in: 'path' }, example: 1 }),
});

export type CreateLeaderboardInput = z.infer<typeof createLeaderboardSchema>;
export type UpdateLeaderboardInput = z.infer<typeof updateLeaderboardSchema>;
export type LeaderboardIdInput = z.infer<typeof leaderboardIdSchema>;
