import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { sameTarget, windowTargetSchema } from './window-target.js';
import { isId, POLICY } from './qa-store.js';

const normalize = text => text.normalize('NFC').trim().replace(/\s+/gu, ' ');
const line = z.string().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u)
  .refine(text => normalize(text).length > 0);
const coordinate = z.number().finite().min(0).lt(1);
export const clickAndCheckTextSchema = z.strictObject({
  title: line, beforeText: line, expectedText: line, x: coordinate, y: coordinate,
}).refine(input => normalize(input.beforeText) !== normalize(input.expectedText));

// Bound the decoder's allocation using the JPEG itself, not just the envelope.
function jpeg(image, geometry) {
  const invalid = () => { throw new Error('invalid_scoped_jpeg'); };
  if (image?.mimeType !== 'image/jpeg' || typeof image.data !== 'string' ||
      image.data.length > 4 * Math.ceil(POLICY.maxImageBytes / 3)) invalid();
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length < 12 || bytes.length > POLICY.maxImageBytes || bytes.toString('base64') !== image.data ||
      bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid();
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i++] !== 0xff) invalid();
    while (bytes[i] === 0xff) i++;
    if (i + 8 >= bytes.length) invalid();
    const marker = bytes[i++], size = bytes.readUInt16BE(i);
    if (size < 2 || i + size > bytes.length || marker === 0xda) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const height = bytes.readUInt16BE(i + 3), width = bytes.readUInt16BE(i + 5);
      if (size < 8 || width < 1 || height < 1 || width > 2048 || height > 2048 ||
          width !== geometry?.width || height !== geometry?.height) invalid();
      return bytes;
    }
    i += size;
  }
  invalid();
}

async function readLines(bytes) {
  const tsv = await new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11', 'tsv'],
      { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: { LANG: 'C', OMP_THREAD_LIMIT: '1' } },
      (error, output) => error ? reject(new Error(error.code === 'ENOENT' ? 'ocr_not_installed' : 'ocr_unavailable')) : resolve(output));
    child.stdin.on('error', () => reject(new Error('ocr_unavailable')));
    child.stdin.end(bytes);
  });
  const lines = new Map();
  for (const row of tsv.split('\n')) {
    const fields = row.split('\t');
    if (fields[0] !== '5' || !fields[11]?.trim()) continue;
    const key = fields.slice(1, 5).join(':'), confidence = Number(fields[10]);
    const line = lines.get(key) ?? { words: [], confidence: 100 };
    line.words.push(fields[11]);
    line.confidence = Math.min(line.confidence, confidence);
    lines.set(key, line);
  }
  return [...lines.values()].map(({ words, confidence }) => ({ text: normalize(words.join(' ')), reliable: confidence >= 80 }));
}

function scopedFrame(session, result, previous) {
  const { frameEvidence, image, processStartedAt, observationId } = result;
  if (result.runId !== session.runId || result.status !== 'pass' || result.observerOnly ||
      !sameTarget(result.target, session.target) || !Number.isFinite(processStartedAt) || !isId(observationId) ||
      frameEvidence?.status !== 'available' || !isId(frameEvidence.afterFrameId) ||
      !Number.isSafeInteger(image?.version) || image.version < 1 || image.version !== frameEvidence.frameVersion ||
      !Number.isFinite(image.ageMs) || image.ageMs < 0 || image.ageMs > 2000 ||
      (previous && (image.version <= previous.image.version || processStartedAt !== previous.processStartedAt ||
        observationId === previous.observationId || frameEvidence.afterFrameId === previous.frameEvidence.afterFrameId)))
    throw new Error('scoped_frame_unconfirmed');
  return jpeg(image, result.imageGeometry);
}

const recognizes = (lines, text) => lines.some(line => line.reliable && line.text === text);
const legible = lines => lines.length > 0 && lines.every(line => line.reliable) &&
  lines.some(line => /[\p{L}\p{N}]{3}/u.test(line.text));

export async function clickAndCheckText(session, input, runUrl) {
  const parsed = clickAndCheckTextSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid_arguments');
  const { title, x, y } = parsed.data, before = normalize(parsed.data.beforeText), expected = normalize(parsed.data.expectedText);
  let attempted = false;
  const incomplete = actual => ({ status: attempted ? 'uncertain' : 'blocked', expected, actual,
    replayUrl: runUrl, checkId: null, retrySafe: !attempted });
  try {
    if (!windowTargetSchema.safeParse(session.target).success) return incomplete('window_session_required');
    const observe = () => session.task('qa_observe', { mode: 'pixels', includeImage: true });
    const pre = await observe();
    if (pre.canAct !== true) return incomplete('window_authority_required');
    const preLines = await readLines(scopedFrame(session, pre));
    if (preLines.some(line => line.text === expected)) return incomplete('OCR: expected line already present.');
    if (!recognizes(preLines, before)) return incomplete('OCR: precondition line not confidently recognized.');
    if (!Number.isSafeInteger(pre.image.receivedAt) || Date.now() - pre.image.receivedAt > 2000 ||
        Date.now() < pre.image.receivedAt || !(pre.expiresInMs > 0)) return incomplete('scoped_frame_expired');
    attempted = true;
    // Unlike completion:"ack", this form returns authority and pixels newer than acknowledgement.
    let post = await session.task('qa_act', { observationId: pre.observationId, action: 'mouse',
      mouse: { kind: 'click', button: 'left', count: 1, x, y } });
    if (post.acknowledged !== true) return incomplete('input_acknowledgement_unconfirmed');
    let lines = await readLines(scopedFrame(session, post, pre));
    if (!recognizes(lines, expected)) {
      const initialLegible = legible(lines);
      // Outlast the broker's 2s cached-pixel freshness window before declaring a mismatch.
      await delay(2100);
      const settled = await observe();
      if (settled.canAct !== true) return incomplete('window_authority_required');
      lines = await readLines(scopedFrame(session, settled, post));
      post = settled;
      if (!recognizes(lines, expected) && !(initialLegible && legible(lines)))
        return incomplete('OCR: post-click mismatch not confidently readable.');
    }
    const outcome = recognizes(lines, expected) ? 'pass' : 'fail';
    const actual = outcome === 'pass' ? `OCR: ${expected}` : 'OCR: expected line absent from two legible post-click readings.';
    const check = await session.task('qa_check', { kind: 'visual', title, expected, actual, outcome,
      observationId: post.observationId, context: `Local Tesseract OCR on scoped pixels; before line: ${before}. Not a native or human assessment.` });
    if (check.status !== outcome || !isId(check.stepId) || check.observationId !== post.observationId ||
        check.frameId !== post.frameEvidence.afterFrameId || check.runId !== session.runId)
      return incomplete('visual_check_unconfirmed');
    return { status: outcome, expected, actual, replayUrl: `${runUrl}&step=${check.stepId}`, checkId: check.stepId };
  } catch (error) {
    return incomplete(/^[a-z_]{1,64}$/.test(error.message) ? error.message : 'procedure_unavailable');
  }
}
