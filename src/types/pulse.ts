export interface PulseReport {
  timestamp: string;
  project: string;
  cwd: string;
  convergence: ConvergenceSignal;
  intentAnchoring: IntentAnchoringSignal;
  decisionQuality: DecisionQualitySignal;
  interactionLeverage: "HIGH" | "MEDIUM" | "LOW";
}

export interface ConvergenceSignal {
  /** Total human messages that initiated work */
  exchanges: number;
  /** Distinct outcomes produced (files changed, issues created, etc.) */
  outcomes: number;
  /** exchanges / outcomes — lower is better */
  rate: number;
  /** Human messages that undid/revised/redirected agent output */
  reworkInstances: number;
  /** reworkInstances / exchanges as percentage */
  reworkPercent: number;
}

export interface IntentAnchoringSignal {
  /** Whether INTENTS.md exists in project root */
  intentsPresent: boolean;
  /** Whether CLAUDE.md exists in project root */
  claudeMdPresent: boolean;
  /** Intent IDs parsed from INTENTS.md */
  declaredIntents: IntentSummary[];
  /** Intent IDs that appear relevant to the session's git changes */
  relevantIntents: string[];
  /** Intent IDs that were referenced in commit messages */
  referencedIntents: string[];
  /** Intents relevant but not referenced — the gap */
  gap: string[];
  /** intentlayer check output, if available */
  intentLayerCheck: IntentLayerCheckResult | null;
}

export interface IntentSummary {
  id: string;
  title: string;
  health: string;
}

export interface IntentLayerCheckResult {
  status: string;
  intents: number;
  commitCoverage: { referenced: number; total: number; percent: number };
  warnings: string[];
  fatals: string[];
}

export interface DecisionQualitySignal {
  /** Commits made during this session (since session start or last N) */
  commitsTotal: number;
  /** Commits whose message references "why" (because, so that, to prevent, etc.) */
  commitsWithWhy: number;
  /** Commits that reference an issue number (#N) */
  commitsWithIssueRef: number;
  /** Whether user provided external context (URLs, issue links, spec files) */
  externalContextProvided: boolean;
  /** Commit messages from the session */
  commitMessages: string[];
}
