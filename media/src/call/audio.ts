/**
 * G.711 μ-law codec and frame arithmetic for the telephone audio path.
 *
 * Twilio Media Streams speak 8 kHz mono μ-law in 20 ms frames — 160 bytes of
 * payload, base64-encoded, roughly fifty times a second per direction. Every
 * function here is on the hot path for a live call, so they are written to
 * allocate once and do integer arithmetic in place.
 *
 * The implementation follows the Sun Microsystems reference for G.711, which is
 * what practically every telephone network agrees on. It is transcribed rather
 * than invented: the constants below are the ones in the spec, and the tests
 * check round-trip fidelity against the quantisation error the standard allows.
 */

/** Samples per second on a PSTN call leg. */
export const SAMPLE_RATE = 8000;

/** Milliseconds of audio in one Twilio media frame. */
export const FRAME_MS = 20;

/** Bytes in one 20 ms μ-law frame at 8 kHz. */
export const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS; // 160

const BIAS = 0x84;
const CLIP = 8159;
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_MASK = 0x70;
const SEG_SHIFT = 4;

/** Upper bound of each μ-law segment, used to find the exponent when encoding. */
const SEG_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

function segmentFor(value: number): number {
  for (let i = 0; i < SEG_END.length; i++) {
    if (value <= SEG_END[i]!) return i;
  }
  return SEG_END.length;
}

/**
 * Encode one 16-bit signed PCM sample to a μ-law byte.
 *
 * μ-law is a logarithmic companding curve: it spends its 8 bits unevenly,
 * giving fine resolution to quiet samples and coarse resolution to loud ones,
 * because that is how hearing works. The result is roughly 14 bits of perceived
 * dynamic range in 8 bits of wire.
 */
export function encodeSample(pcm: number): number {
  let value = pcm >> 2; // 16-bit signed down to the 14 bits μ-law encodes
  let mask: number;

  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }

  if (value > CLIP) value = CLIP;
  value += BIAS >> 2;

  const seg = segmentFor(value);
  if (seg >= 8) return 0x7f ^ mask;

  const uval = (seg << SEG_SHIFT) | ((value >> (seg + 1)) & QUANT_MASK);
  return uval ^ mask;
}

/** Decode one μ-law byte back to a 16-bit signed PCM sample. */
export function decodeSample(ulaw: number): number {
  const u = ~ulaw & 0xff;
  let t = ((u & QUANT_MASK) << 3) + BIAS;
  t <<= (u & SEG_MASK) >> SEG_SHIFT;
  return (u & SIGN_BIT) !== 0 ? BIAS - t : t - BIAS;
}

/** Decode a μ-law buffer into 16-bit PCM samples. */
export function decode(ulaw: Buffer): Int16Array {
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) pcm[i] = decodeSample(ulaw[i]!);
  return pcm;
}

/** Encode 16-bit PCM samples into a μ-law buffer. */
export function encode(pcm: Int16Array): Buffer {
  const ulaw = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) ulaw[i] = encodeSample(pcm[i]!);
  return ulaw;
}

/**
 * Root-mean-square amplitude of a μ-law frame, normalised to 0..1.
 *
 * This is the cheap half of barge-in detection. It runs on every inbound frame
 * whether or not anyone is speaking, so it decodes without allocating an
 * intermediate array. The expensive half — deciding whether the energy is
 * actually speech rather than a door slamming — lives in turn.ts.
 */
export function frameEnergy(ulaw: Buffer): number {
  if (ulaw.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < ulaw.length; i++) {
    const sample = decodeSample(ulaw[i]!);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / ulaw.length) / 32768;
}

/**
 * Split a buffer into whole 20 ms frames, returning the frames and whatever
 * partial frame is left over.
 *
 * Text-to-speech providers stream audio in chunks sized for their own
 * convenience, not ours. Twilio wants exactly 160 bytes per media message and
 * paces playback off frame count, so a caller-side jitter buffer is not
 * optional — sending ragged chunks makes speech sound rushed then stalled.
 */
export function chunkFrames(buf: Buffer): { frames: Buffer[]; remainder: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset + FRAME_BYTES <= buf.length) {
    frames.push(buf.subarray(offset, offset + FRAME_BYTES));
    offset += FRAME_BYTES;
  }
  return { frames, remainder: buf.subarray(offset) };
}

/** Duration in milliseconds of a μ-law buffer at 8 kHz. */
export function durationMs(ulaw: Buffer): number {
  return (ulaw.length / SAMPLE_RATE) * 1000;
}

/** A frame of μ-law silence, for padding and comfort noise. */
export const SILENCE_FRAME: Buffer = Buffer.alloc(FRAME_BYTES, encodeSample(0));

/**
 * Resample 16-bit PCM by linear interpolation.
 *
 * Only needed for providers that refuse 8 kHz μ-law and insist on 16 kHz PCM.
 * The preferred path avoids this entirely — both Deepgram and Cartesia can be
 * asked to speak μ-law at 8 kHz directly, which skips two conversions and the
 * latency that comes with them. Linear interpolation is not a good resampler,
 * but upsampling a band-limited 8 kHz telephone signal adds no information no
 * matter how good the filter is, so the cheap one is the honest choice.
 */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm[idx] ?? 0;
    const b = pcm[idx + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}
