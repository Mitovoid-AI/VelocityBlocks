// Compact text form of a run's input log (race.ts RaceSession.inputs: INPUT_STRIDE numbers per racing tick).
// Runs of identical ticks are stored once with a count (a button player holds the same inputs for long
// stretches), as bytes: count (LEB128), steer (signed byte), gas, brake, nitro; then base64. Used by ghosts
// (storage) and shared runs (runShare.ts).

/** Numbers per racing tick in RaceSession.inputs: steer (-127..127), gas (0..255), brake (0..255), nitro (0/1). */
export const INPUT_STRIDE = 4;

export function encodeInputLog(inputs: ArrayLike<number>): string {
  const out: number[] = [];
  const n = Math.floor(inputs.length / INPUT_STRIDE);
  const same = (a: number, b: number) => {
    for (let j = 0; j < INPUT_STRIDE; j++) if (inputs[a * INPUT_STRIDE + j] !== inputs[b * INPUT_STRIDE + j]) return false;
    return true;
  };
  for (let t = 0; t < n; ) {
    let run = 1;
    while (t + run < n && same(t, t + run)) run++;
    for (let c = run; ; ) {
      const b = c & 0x7f;
      c >>>= 7;
      out.push(c ? b | 0x80 : b);
      if (!c) break;
    }
    for (let j = 0; j < INPUT_STRIDE; j++) out.push(inputs[t * INPUT_STRIDE + j] & 0xff);
    t += run;
  }
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.slice(i, i + 0x8000));
  return btoa(bin);
}

/** The input log back, or null when the text is not one. */
export function decodeInputLog(text: string): Int16Array | null {
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    return null;
  }
  const out: number[] = [];
  let i = 0;
  while (i < bin.length) {
    let count = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= bin.length || shift > 28) return null;
      const b = bin.charCodeAt(i++);
      count |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    if (i + INPUT_STRIDE > bin.length || count < 1) return null;
    const steer = bin.charCodeAt(i);
    const tick = [steer > 127 ? steer - 256 : steer, bin.charCodeAt(i + 1), bin.charCodeAt(i + 2), bin.charCodeAt(i + 3)];
    i += INPUT_STRIDE;
    for (let k = 0; k < count; k++) out.push(...tick);
  }
  return Int16Array.from(out);
}
