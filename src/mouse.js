import { z } from 'zod';

const coordinate = z.number().finite().min(0).lt(1);
const point = { x: coordinate, y: coordinate };
export const mouseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('move'), ...point }),
  z.strictObject({ kind: z.literal('click'), ...point, button: z.enum(['left', 'right']),
    count: z.number().int().min(1).max(2) }),
  z.strictObject({ kind: z.literal('drag'), ...point, toX: coordinate, toY: coordinate,
    durationMs: z.number().int().min(100).max(1000) }),
  z.strictObject({ kind: z.literal('scroll'), ...point,
    deltaX: z.number().int().min(-600).max(600), deltaY: z.number().int().min(-600).max(600) }),
]);
