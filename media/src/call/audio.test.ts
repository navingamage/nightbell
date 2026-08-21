import { describe, expect, it } from "vitest";
import {
  FRAME_BYTES,
  SILENCE_FRAME,
  chunkFrames,
  decode,
  decodeSample,
  durationMs,
  encode,
  encodeSample,
  frameEnergy,
  resample,
} from "./audio.js";

describe("μ-law codec", () => {
  it("round-trips every byte except negative zero, which canonicalises", () => {
    // Decoding then re-encoding must be the identity, otherwise audio that
    // passes through us twice would drift.
    //
    // G.711 has one wrinkle here worth pinning down rather than papering over:
    // μ-law can express zero two ways. 0x7F is "negative zero" and 0xFF is
    // "positive zero", and both decode to sample 0. The encoder only ever
    // emits the positive form, so 0x7F is the single byte that does not
    // survive a round trip. That is correct behaviour, not loss.
    for (let byte = 0; byte < 256; byte++) {
      const expected = byte === 0x7f ? 0xff : byte;
      expect(encodeSample(decodeSample(byte))).toBe(expected);
    }
  });

  it("decodes both zero encodings to silence", () => {
    expect(decodeSample(0x7f)).toBe(0);
    expect(decodeSample(0xff)).toBe(0);
  });

  it("keeps quantisation error within one step of the sample's segment", () => {
    // μ-law is lossy by design. The guarantee it makes is not a flat error
    // bound but a per-segment one: the curve spends fine steps near zero and
    // coarse steps at the top, so the allowed error grows with amplitude.
    // This mirrors the segment arithmetic from the spec rather than guessing a
    // tolerance, which is the whole point of the assertion.
    // The step is read off the encoded byte rather than off the input, because
    // a sample sitting near a segment boundary encodes into the segment above
    // it and is then reconstructed with that segment's coarser step.
    const stepForByte = (ulaw: number): number => {
      const seg = ((~ulaw & 0xff) & 0x70) >> 4;
      return (1 << (seg + 1)) << 2; // segment step, scaled back up to 16-bit
    };

    for (let pcm = -32768; pcm < 32768; pcm += 7) {
      const encoded = encodeSample(pcm);
      const recovered = decodeSample(encoded);
      expect(Math.abs(recovered - pcm)).toBeLessThanOrEqual(stepForByte(encoded));
    }
  });

  it("preserves sign except at zero crossing", () => {
    for (const pcm of [-20000, -8000, -100, 100, 8000, 20000]) {
      const recovered = decodeSample(encodeSample(pcm));
      expect(Math.sign(recovered)).toBe(Math.sign(pcm));
    }
  });

  it("clips rather than wrapping on out-of-range input", () => {
    // Anything past the clip point must saturate to the same loud sample, and
    // must stay positive: a wrap would turn a shout into a shout of the
    // opposite sign, which is an audible crackle.
    // The clip point is 8159 in the 14-bit domain, i.e. 32636 at 16-bit, so
    // both of these are past it and must saturate to the same sample.
    const atClip = decodeSample(encodeSample(32700));
    const overClip = decodeSample(encodeSample(32767));
    expect(overClip).toBe(atClip);
    expect(overClip).toBeGreaterThan(0);
  });

  it("round-trips buffers", () => {
    const pcm = new Int16Array([0, 1000, -1000, 16000, -16000]);
    const restored = decode(encode(pcm));
    expect(restored.length).toBe(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(restored[i]! - pcm[i]!)).toBeLessThan(1200);
    }
  });
});

describe("frameEnergy", () => {
  it("reports near zero for silence", () => {
    expect(frameEnergy(SILENCE_FRAME)).toBeLessThan(0.01);
  });

  it("reports higher energy for louder audio", () => {
    const quiet = encode(new Int16Array(160).fill(500));
    const loud = encode(new Int16Array(160).fill(15000));
    expect(frameEnergy(loud)).toBeGreaterThan(frameEnergy(quiet));
  });

  it("returns zero for an empty buffer rather than NaN", () => {
    expect(frameEnergy(Buffer.alloc(0))).toBe(0);
  });

  it("is normalised below one for full-scale input", () => {
    const fullScale = encode(new Int16Array(160).fill(32000));
    expect(frameEnergy(fullScale)).toBeLessThanOrEqual(1);
    expect(frameEnergy(fullScale)).toBeGreaterThan(0.5);
  });
});

describe("chunkFrames", () => {
  it("splits into whole frames and keeps the remainder", () => {
    const buf = Buffer.alloc(FRAME_BYTES * 3 + 40);
    const { frames, remainder } = chunkFrames(buf);
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.length === FRAME_BYTES)).toBe(true);
    expect(remainder.length).toBe(40);
  });

  it("returns no frames when given less than one frame", () => {
    const { frames, remainder } = chunkFrames(Buffer.alloc(FRAME_BYTES - 1));
    expect(frames).toHaveLength(0);
    expect(remainder.length).toBe(FRAME_BYTES - 1);
  });

  it("leaves no remainder on an exact multiple", () => {
    const { frames, remainder } = chunkFrames(Buffer.alloc(FRAME_BYTES * 2));
    expect(frames).toHaveLength(2);
    expect(remainder.length).toBe(0);
  });
});

describe("durationMs", () => {
  it("computes 20 ms for one frame", () => {
    expect(durationMs(Buffer.alloc(FRAME_BYTES))).toBe(20);
  });

  it("scales linearly", () => {
    expect(durationMs(Buffer.alloc(FRAME_BYTES * 50))).toBe(1000);
  });
});

describe("resample", () => {
  it("is a no-op at equal rates", () => {
    const pcm = new Int16Array([1, 2, 3]);
    expect(resample(pcm, 8000, 8000)).toBe(pcm);
  });

  it("doubles length when upsampling 8k to 16k", () => {
    const pcm = new Int16Array(160);
    expect(resample(pcm, 8000, 16000).length).toBe(320);
  });

  it("halves length when downsampling 16k to 8k", () => {
    const pcm = new Int16Array(320);
    expect(resample(pcm, 16000, 8000).length).toBe(160);
  });

  it("interpolates between neighbouring samples", () => {
    const pcm = new Int16Array([0, 100]);
    const up = resample(pcm, 8000, 16000);
    expect(up[0]).toBe(0);
    expect(up[1]).toBe(50);
  });
});
