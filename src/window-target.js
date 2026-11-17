import { z } from 'zod';

export const bundleIdSchema = z.string().max(255).regex(/^[A-Za-z0-9._-]*$/);
export const sampleBundle = 'com.factory.applets.RelayMac';
export const unsupportedControlBundles = ['com.factory.applets.host', 'com.apple.iphonesimulator', 'com.apple.dt.Devices'];
export const windowTargetSchema = z.strictObject({
  windowId: z.number().int().min(1).max(0xffffffff),
  pid: z.number().int().min(1).max(0x7fffffff),
  bundleId: bundleIdSchema,
});
export const macBundleIdSchema = bundleIdSchema.refine(id => !unsupportedControlBundles.includes(id));
export const desktopTargetSchema = z.strictObject({
  kind: z.literal('desktop'),
  displayId: z.number().int().min(1).max(0xffffffff),
  displayUUID: z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
});
export const targetSchema = z.union([windowTargetSchema, desktopTargetSchema]);
export const pointBoundsSchema = z.tuple([z.number().finite(), z.number().finite(),
  z.number().positive().max(16384).finite(), z.number().positive().max(16384).finite()]);
export const displayConfigurationSchema = z.strictObject({
  boundsPoints: pointBoundsSchema,
  pixelWidth: z.number().int().positive().max(32768),
  pixelHeight: z.number().int().positive().max(32768),
  rotation: z.number().finite().min(0).lt(360),
  scaleX: z.number().positive().max(16), scaleY: z.number().positive().max(16),
});
export { isDesktop, targetIdentity, sameTarget, sameDisplayConfiguration } from '../web/target-identity.js';
