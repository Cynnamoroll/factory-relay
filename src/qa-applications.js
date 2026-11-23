import { z } from 'zod';
import { macBundleIdSchema, sampleBundle, isDesktop, sameTarget } from './window-target.js';

export const applicationIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const common = {
  id: applicationIdSchema,
  name: z.string().regex(/^[^\x00-\x1f\x7f-\x9f]+$/).trim().min(1).max(120),
  bundleId: z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/),
};
const profile = z.discriminatedUnion('platform', [
  z.strictObject({ ...common, platform: z.literal('macos') }),
  z.strictObject({ ...common, platform: z.literal('ios-simulator'), simulatorUdid: z.string().uuid().toLowerCase() }),
]);
export const applicationsSchema = z.array(profile).max(32).superRefine((applications, ctx) => {
  const ids = new Set(), identities = new Set();
  for (const [index, app] of applications.entries()) {
    const identity = JSON.stringify([app.platform, app.bundleId, app.simulatorUdid ?? null]);
    if (ids.has(app.id) || identities.has(identity))
      ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate application ID or identity' });
    ids.add(app.id);
    identities.add(identity);
  }
});
const builtin = Object.freeze({
  id: 'relaymac', name: 'RelayMac', platform: 'macos', bundleId: 'com.factory.applets.RelayMac',
});

const interactiveProfiles = new WeakSet();
export function applicationProfiles(applications) {
  if (interactiveProfiles.has(applications)) return applications;
  const profiles = Object.freeze(applicationsSchema.parse(applications === undefined ? [builtin] : applications).map(Object.freeze));
  if (applications === undefined) interactiveProfiles.add(profiles);
  return profiles;
}
const implemented = app => app.platform === 'macos' && (isDesktop(app) || macBundleIdSchema.safeParse(app.bundleId).success);
const matchesTarget = (app, target) => app.platform === 'macos' && app.bundleId === target.bundleId;

export function capabilities(app) {
  return implemented(app)
    ? { sharedQA: true, observe: ['pixels', ...(app.bundleId === sampleBundle ? ['count'] : [])],
      act: ['mouse', ...(app.bundleId === sampleBundle ? ['increment'] : [])],
      check: ['visual', ...(app.bundleId === sampleBundle ? ['count'] : [])], recording: true,
      mouse: isDesktop(app)
        ? { route: 'foreground-hid', lease: 'exclusive', kinds: ['move', 'click', 'drag', 'scroll'] }
        : { route: 'background-ax-press', lease: 'window', kinds: ['click'], buttons: ['left'], counts: [1] } }
    : { sharedQA: false, reason: 'driver_not_implemented', observe: [], act: [], check: [], recording: false };
}
export function nativeAuthorized(applications, target) {
  if (isDesktop(target)) return interactiveProfiles.has(applications);
  if (target && !macBundleIdSchema.safeParse(target.bundleId).success) return false;
  return interactiveProfiles.has(applications) || applications.some(app => implemented(app) && (!target || matchesTarget(app, target)));
}
export function requireNativeAuthorization(applications, target) {
  if (!nativeAuthorized(applications, target)) throw new Error('application_not_authorized');
}
function resolve(applications, { applicationId, target }) {
  if (isDesktop(target) || !target && applicationId === 'desktop' && interactiveProfiles.has(applications)) {
    if (!interactiveProfiles.has(applications)) throw new Error('application_not_authorized');
    if (applicationId !== undefined && applicationId !== 'desktop') throw new Error('application_mismatch');
    return { id: 'desktop', name: 'Desktop', platform: 'macos', kind: 'desktop' };
  }
  if (target && interactiveProfiles.has(applications) && !applications.some(app => matchesTarget(app, target))) {
    if (!nativeAuthorized(applications, target)) throw new Error('application_not_authorized');
    const runtime = { id: `window-${target.pid}-${target.windowId}`, name: `Window ${target.windowId}`,
      platform: 'macos', bundleId: target.bundleId };
    if (applicationId !== undefined && applicationId !== runtime.id) throw new Error('application_mismatch');
    return runtime;
  }
  if (applicationId !== undefined) {
    const app = applications.find(app => app.id === applicationId);
    if (!app) throw new Error('unknown_application');
    if (target && !matchesTarget(app, target)) throw new Error('application_mismatch');
    return app;
  }
  const candidates = target ? applications.filter(app => matchesTarget(app, target)) : applications;
  if (!candidates.length) throw new Error('application_unavailable');
  if (candidates.length !== 1) throw new Error('application_ambiguous');
  return candidates[0];
}
export function selectApplication(applications, args, runStart) {
  let app;
  if (runStart) {
    app = resolve(applications, { applicationId: runStart.labels?.applicationId, target: runStart.target });
    if (args.applicationId !== undefined && args.applicationId !== app.id)
      throw new Error('application_mismatch');
    if (args.target && !sameTarget(args.target, runStart.target))
      throw new Error('target_mismatch');
  } else app = resolve(applications, args);
  if (!implemented(app)) throw new Error('application_not_supported');
  return app;
}
