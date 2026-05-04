/**
 * Objective Discovery — P2P topic self-assignment
 *
 * When a BEE starts with no HIVE_OBJECTIVE, this module:
 * 1. Queries known peers for their current knowledge topics
 * 2. Asks Gemini to suggest a complementary topic not yet covered
 * 3. Returns that as the BEE's running objective
 *
 * No central authority. The BEE reads observable network state and decides.
 */

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

export interface NetworkTopics {
  peerUrl: string;
  nodeId: string;
  titles: string[];
  count: number;
}

export async function scanNetworkTopics(peerApis: string[]): Promise<NetworkTopics[]> {
  const results: NetworkTopics[] = [];
  for (const url of peerApis) {
    try {
      const res = await fetch(`${url}/api/topics`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { nodes: Array<{ nodeId: string; titles: string[]; count: number }> };
      for (const node of data.nodes ?? []) {
        results.push({ peerUrl: url, ...node });
      }
    } catch {}
  }
  return results;
}

export async function discoverObjective(
  peerApis: string[],
  apiKey: string,
): Promise<string> {
  // Step 1: gather what the network already knows
  const networkTopics = await scanNetworkTopics(peerApis);

  if (!networkTopics.length) {
    // No peers — bootstrap with a broad foundational topic
    return 'Find recent scientific papers about artificial intelligence, machine learning, and deep learning fundamentals';
  }

  // Step 2: summarise existing coverage
  const covered = networkTopics
    .flatMap(n => n.titles.slice(0, 5))
    .join('\n- ');

  const prompt = `You are helping a new HIVE knowledge BEE decide what domain to specialise in.

The HIVE network already has BEEs covering these topics (based on indexed paper titles):
- ${covered}

Your task: suggest ONE specific research area that would COMPLEMENT what the network already has, filling a knowledge gap. It should be:
- A real scientific/technical domain with active research
- Different enough from the existing topics to add value
- Specific enough to guide a focused search agent

Reply with ONLY a single sentence describing the objective, like:
"Find recent papers about [topic]"

Do not explain your reasoning. Just the objective sentence.`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 100 },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = (await res.json()) as any;
    const objective = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (objective) return objective;
  } catch (e: any) {
    console.warn(`[objective] Gemini error: ${e.message} — using fallback`);
  }

  // Fallback: pick a random gap topic
  const fallbacks = [
    'Find recent papers about quantum computing algorithms and error correction',
    'Find recent papers about climate change modeling and carbon capture',
    'Find recent papers about computational biology and protein structure prediction',
    'Find recent papers about robotics, autonomous systems and reinforcement learning',
    'Find recent papers about cybersecurity, adversarial attacks and privacy-preserving ML',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}
