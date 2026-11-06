// Audio containers the voice path needs. The app records push-to-talk as raw 16-bit PCM at 16 kHz (protocol
// `voice.listen`'s `pcm16-16k`), and Fish Audio's speech-to-text refuses raw, headerless PCM (docs: "Not supported
// (400): … raw headerless PCM"), so PCM is wrapped in a WAV header first. Fish's text-to-speech answers `pcm` as raw
// 16-bit mono samples, which is what `voice.play`'s `pcm16-24k` takes at 24 kHz.

/** A RIFF/WAVE file around 16-bit little-endian PCM. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  if (pcm.length % (2 * channels) !== 0) throw new RangeError("PCM16 audio is whole 16-bit frames");
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** A WAV file's PCM samples, sample rate and channels, when it is plain 16-bit PCM. */
export function readWav(wav: Uint8Array): { pcm: Uint8Array; sampleRate: number; channels: number } | undefined {
  if (wav.length < 44) return undefined;
  const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") return undefined;
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (at + 8 <= wav.length) {
    const id = text(at, 4);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt ") {
      if (v.getUint16(at + 8, true) !== 1) return undefined;
      channels = v.getUint16(at + 10, true);
      sampleRate = v.getUint32(at + 12, true);
      bits = v.getUint16(at + 22, true);
    } else if (id === "data") {
      if (bits !== 16 || channels === 0) return undefined;
      return { pcm: wav.subarray(at + 8, Math.min(wav.length, at + 8 + size)), sampleRate, channels };
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** What a byte string starts like: Fish's speech-to-text detects the format from the contents, not the name. */
export function sniffAudio(bytes: Uint8Array): "wav" | "mp3" | "ogg" | "flac" | "unknown" {
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE") return "wav";
  if (head === "OggS") return "ogg";
  if (head === "fLaC") return "flac";
  if (head.startsWith("ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  return "unknown";
}

/** Seconds of 16-bit mono PCM at a sample rate. */
export function pcm16Seconds(bytes: number, sampleRate: number): number {
  return bytes / (2 * sampleRate);
}
