import { actionCues, cueAt, cueGeometry, cueLabel, CUE_LEGEND, fitPoint } from '../web/action-cues.js';
import { displayConfigurationSchema, sameTarget, sameDisplayConfiguration } from './window-target.js';

export function displayCue(cues, at, frame) {
  const h = frame?.header, recording = frame?.recording;
  if (!displayConfigurationSchema.safeParse(h?.displayConfiguration).success || h.kind !== 'desktop' ||
      !sameTarget(h, recording?.displayTarget) || !sameDisplayConfiguration(h.displayConfiguration, recording?.displayConfiguration) ||
      !Number.isFinite(recording?.windowReceivedElapsedMs) || at - recording.windowReceivedElapsedMs > 2000 ||
      at < recording.windowReceivedElapsedMs) return null;
  const cue = cueAt(cues, at, recording.windowHeader);
  if (!cue?.point) return cue;
  const s = cue.geometry.snapshot, window = cueGeometry(recording.windowHeader, s);
  const display = cueGeometry(h, { target: h, displayConfiguration: h.displayConfiguration });
  if (!window || !display || !sameTarget(s.target, recording.windowHeader)) return null;
  const x = (cue.point.x * window.width - window.content[0]) / window.content[2];
  const y = (cue.point.y * window.height - window.content[1]) / window.content[3];
  const bounds = h.displayConfiguration.boundsPoints, r = s.windowRectPoints;
  const dx = (r[0] + x * r[2] - bounds[0]) / bounds[2], dy = (r[1] + y * r[3] - bounds[1]) / bounds[3];
  if (![dx, dy].every(n => Number.isFinite(n) && n >= 0 && n < 1)) return null;
  return { ...cue, point: { x: (display.content[0] + dx * display.content[2]) / display.width,
    y: (display.content[1] + dy * display.content[3]) / display.height } };
}

const stamp = ms => {
  const cs = Math.max(0, Math.floor(ms / 10));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const dialogue = (start, end, body) => `Dialogue: 0,${stamp(start)},${stamp(Math.max(start + 10, end))},Default,,0,0,0,,${body}`;

/** Subdivide held evidence, never extend its receive-clock interval or fill a gap. */
export function cursorPresentation(events, segments, durationMs) {
  const cues = actionCues(events), frames = new Map(events.filter(e => ['frame', 'recording-frame'].includes(e.kind)).map(e => [e.frameId, e]));
  const packets = [], lines = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1280', 'PlayResY: 720',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,DejaVu Sans,17,&H00FFFFFF,&H00FFFFFF,&H00101318,&H90101318,0,0,0,0,100,100,0,0,1,2,0,7,12,12,12,1',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    dialogue(0, durationMs, `{\\an1\\pos(12,708)}${CUE_LEGEND}`),
  ];
  for (const segment of segments) {
    const sourceStart = segment.sourceStartMs ?? segment.startMs;
    const sourceEnd = sourceStart + segment.endMs - segment.startMs;
    const cuts = new Set([sourceStart, sourceEnd]);
    if (segment.kind === 'frame') for (const cue of cues) {
      const start = Math.max(sourceStart, cue.startMs), end = Math.min(sourceEnd, cue.endMs);
      if (end <= start) continue;
      cuts.add(start); cuts.add(end);
      for (let ms = start + 40; ms < end; ms += 40) cuts.add(ms);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const at = sorted[i], start = segment.startMs + at - sourceStart, end = segment.startMs + sorted[i + 1] - sourceStart;
      packets.push({ ...segment, startMs: start, endMs: end,
        ...(segment.sourceStartMs === undefined ? {} : { sourceStartMs: at, sourceEndMs: sorted[i + 1] }) });
      if (packets.length > 26000) throw new Error('cursor_packet_limit');
      const frame = frames.get(segment.frameId), cue = segment.kind === 'frame' &&
        (frame?.kind === 'recording-frame' ? displayCue(cues, at, frame) : cueAt(cues, at, frame?.header));
      if (!cue) continue;
      lines.push(dialogue(start, end, `{\\an9\\pos(1268,48)}${cueLabel(cue)}`));
      if (!cue.point) continue;
      const p = fitPoint(cue.point, frame.header.width, frame.header.height, 1280, 720);
      const x = Math.round(p.x), y = Math.round(p.y), color = cue.actor === 'agent' ? '&H00E8D040&' : '&H00FFAAEE&';
      lines.push(dialogue(start, end, `{\\pos(${x},${y})\\an7\\1c${color}\\bord2\\p1}m 0 0 l 0 25 7 19 12 30 17 27 12 17 22 17 0 0{\\p0}`));
    }
  }
  return { packets, ass: lines.join('\n') + '\n', cues };
}
