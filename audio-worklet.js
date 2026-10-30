// Converts microphone audio to 16-bit PCM and posts it in 100 ms chunks (1600 samples at
// 16 kHz), along with the loudest sample in each chunk for the level meter.
class Pcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    const channel = inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        if (Math.abs(s) > this.peak) this.peak = Math.abs(s);
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) {
          this.port.postMessage({ pcm: this.buf.buffer, peak: this.peak }, [this.buf.buffer]);
          this.buf = new Int16Array(1600);
          this.n = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm16", Pcm16);
