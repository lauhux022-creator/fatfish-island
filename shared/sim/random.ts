export function seededRandom(seed: string) {
  let state = 2166136261;
  for (const codePoint of seed) state = Math.imul(state ^ codePoint.codePointAt(0)!, 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let word = Math.imul(state ^ (state >>> 15), state | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    return ((word ^ (word >>> 14)) >>> 0) / 4294967296;
  };
}
