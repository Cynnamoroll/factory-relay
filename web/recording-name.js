const clean = (value, limit = 160) => typeof value === 'string'
  ? Array.from(value.toWellFormed().replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('') : '';
const meaningful = value => {
  const text = clean(value);
  return /^(?:QA(?: run| session| test)?|native application|window recording)$/i.test(text) ? '' : text;
};
const purpose = (applicationName, value) => {
  const text = clean(value);
  const prefix = `${applicationName} - `;
  return meaningful(text.toLowerCase().startsWith(prefix.toLowerCase()) ? text.slice(prefix.length) : text);
};
const title = (applicationName, description) => `${applicationName} - ${description || 'QA session'}`;
const bytePrefix = (value, limit) => {
  let result = '', bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0), size = point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    if (bytes + size > limit) break;
    result += character; bytes += size;
  }
  return result;
};

export function recordingLabels(labels, target, discovered, application) {
  const applicationName = target?.kind === 'desktop' ? 'Shared display'
    : clean(discovered?.displayName, 120) ||
      (!/^Window \d+$/.test(application?.name ?? '') && clean(application?.name, 120)) ||
      `Application (PID ${target?.pid ?? 'unknown'})`;
  const supplied = purpose(applicationName, labels.title), context = purpose(applicationName, labels.context);
  const testDescription = supplied || context;
  return { ...labels, applicationName, testDescription, titleSource: supplied ? 'caller' : context ? 'context' : 'check',
    title: title(applicationName, testDescription) };
}

export function recordingName(events) {
  const labels = events?.[0]?.labels ?? {};
  if (!labels.applicationName) return { title: labels.title ?? 'QA run', applicationName: null, testDescription: null };
  const applicationName = clean(labels.applicationName, 120);
  const namedCheck = labels.titleSource === 'check' ? events.find(event =>
    (event.kind === 'assertion' || event.kind === 'step-start' && ['assert-count', 'assert-visual'].includes(event.operation)) &&
    purpose(applicationName, event.title) && event.title !== 'Count assertion') : null;
  const testDescription = namedCheck ? purpose(applicationName, namedCheck.title) : clean(labels.testDescription);
  return { applicationName, testDescription: testDescription || null, title: title(applicationName, testDescription) };
}

export function recordingFilename(displayTitle, runId, artifact) {
  const safe = value => clean(value, 400).replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  const full = safe(displayTitle) || 'QA session';
  const name = bytePrefix(full, 180) === full ? full
    : `${bytePrefix(full, 90)}...${Array.from(bytePrefix(Array.from(full).reverse().join(''), 87)).reverse().join('')}`;
  const extension = artifact.endsWith('.mp4') ? 'mp4' : artifact.endsWith('.jpg') ? 'jpg' : 'json';
  const variant = artifact.startsWith('qa-') ? 'QA' : 'full-session';
  const kind = extension === 'jpg' ? 'poster' : extension === 'json' ? 'summary' : 'recording';
  return `${name} - ${variant} ${kind} - ${safe(runId)}.${extension}`;
}

export function recordingDisposition(displayTitle, runId, artifact) {
  const filename = recordingFilename(displayTitle, runId, artifact);
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
