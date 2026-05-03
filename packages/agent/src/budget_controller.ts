export interface BudgetConfig {
  maxTokens: number;       // total input+output tokens
  maxWebFetches: number;   // web page fetches
  maxArxivCalls: number;   // arXiv API queries
  maxFragments: number;    // fragments to extract
  maxMinutes: number;      // wall-clock time
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxTokens: 200_000,
  maxWebFetches: 20,
  maxArxivCalls: 10,
  maxFragments: 50,
  maxMinutes: 30,
};

export class BudgetController {
  tokensUsed = 0;
  webFetches = 0;
  arxivCalls = 0;
  fragmentsExtracted = 0;
  private startTime = Date.now();

  constructor(private cfg: BudgetConfig = DEFAULT_BUDGET) {}

  recordTokens(n: number)    { this.tokensUsed += n; }
  recordWebFetch()           { this.webFetches++; }
  recordArxivCall()          { this.arxivCalls++; }
  recordFragments(n: number) { this.fragmentsExtracted += n; }

  exhausted(): { yes: boolean; reason?: string } {
    const mins = (Date.now() - this.startTime) / 60_000;
    if (this.tokensUsed >= this.cfg.maxTokens)          return { yes: true, reason: `token limit (${this.tokensUsed})` };
    if (this.webFetches >= this.cfg.maxWebFetches)       return { yes: true, reason: `web fetch limit (${this.webFetches})` };
    if (this.arxivCalls >= this.cfg.maxArxivCalls)       return { yes: true, reason: `arXiv call limit (${this.arxivCalls})` };
    if (this.fragmentsExtracted >= this.cfg.maxFragments) return { yes: true, reason: `fragment limit (${this.fragmentsExtracted})` };
    if (mins >= this.cfg.maxMinutes)                     return { yes: true, reason: `time limit (${mins.toFixed(1)}min)` };
    return { yes: false };
  }

  summary() {
    return {
      tokensUsed: this.tokensUsed,
      webFetches: this.webFetches,
      arxivCalls: this.arxivCalls,
      fragmentsExtracted: this.fragmentsExtracted,
      elapsedMinutes: ((Date.now() - this.startTime) / 60_000).toFixed(1),
    };
  }
}
