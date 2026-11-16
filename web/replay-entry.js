export class ReplayEntry {
  constructor(video, blocked) {
    this.video = video;
    this.blocked = blocked;
    this.version = 0;
    video.addEventListener('loadedmetadata', () => this.flush());
  }
  openMilliseconds(milliseconds, autoplay = true) {
    this.pending = { seconds: Math.max(0, milliseconds / 1000), autoplay, version: ++this.version };
    return this.flush();
  }
  cancel() {
    this.version++;
    this.pending = null;
  }
  async flush() {
    if (!this.pending || this.video.readyState < 1) return;
    const intent = this.pending;
    this.pending = null;
    try {
      this.video.currentTime = intent.seconds;
      // QA recordings have no audio; muting also permits gesture-free browser playback.
      this.video.muted = true;
      if (intent.autoplay) await this.video.play();
    } catch {
      if (intent.version === this.version) this.blocked();
    }
  }
}
