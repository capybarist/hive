export interface Chunk {
  text: string;
  index: number;
}

const CHARS_PER_TOKEN = 4;

export function chunkText(
  text: string,
  maxTokens: number = 200,
  overlapTokens: number = 40,
): Chunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const step = maxChars - overlapChars;

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push({ text: chunk, index });
      index++;
    }
    if (end === text.length) break;
    start += step;
  }

  return chunks;
}
