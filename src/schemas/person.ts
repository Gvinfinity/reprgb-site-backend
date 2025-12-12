import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const createPersonSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, 'Name is required'),
  dateOfBirth: z.string().datetime().or(z.date()),
  color: z.string().optional(),
  isHousemate: z.boolean().optional().default(false),
});

export const updatePersonSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  dateOfBirth: z.string().datetime().or(z.date()).optional(),
  color: z.string().optional().nullable(),
  isHousemate: z.boolean().optional(),
});

export const personIdSchema = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' }, example: '123e4567-e89b-12d3-a456-426614174000' }),
});

export type CreatePersonInput = z.infer<typeof createPersonSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;
export type PersonIdInput = z.infer<typeof personIdSchema>;
