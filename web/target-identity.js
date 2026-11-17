export const isDesktop = target => target?.kind === 'desktop';
export const targetIdentity = target => isDesktop(target)
  ? { kind: 'desktop', displayId: target.displayId, displayUUID: target.displayUUID }
  : { windowId: target.windowId, pid: target.pid, bundleId: target.bundleId };
export const sameTarget = (a, b) => Boolean(a && b) && isDesktop(a) === isDesktop(b) &&
  (isDesktop(a) ? ['displayId', 'displayUUID'] : ['windowId', 'pid', 'bundleId']).every(k => a[k] !== undefined && a[k] === b[k]);
export const sameDisplayConfiguration = (a, b) => Boolean(a && b) &&
  ['pixelWidth', 'pixelHeight', 'rotation', 'scaleX', 'scaleY'].every(k => a[k] !== undefined && a[k] === b[k]) &&
  a.boundsPoints?.length === 4 && a.boundsPoints.every((n, i) => n === b.boundsPoints?.[i]);
export const sameSnapshotIdentity = (a, b) => sameTarget(a?.target, b?.target) &&
  (isDesktop(a.target) ? sameDisplayConfiguration(a.displayConfiguration, b.displayConfiguration)
    : a.processStartedAt === b.processStartedAt);
export const targetLabel = target => isDesktop(target)
  ? `Desktop · ${target.main ? 'Main display' : 'Display'} ${target.displayId}`
  : `${target.displayName || target.title || target.bundleId || 'Application'} · Window ${target.windowId}`;
