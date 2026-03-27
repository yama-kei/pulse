export interface PulseReport {
  timestamp: string;
  project: string;
  cwd: string;
  convergence: ConvergenceSignal;
  intentAnchoring: IntentAnchoringSignal;
  decisionQuality: DecisionQualitySignal;
  tokenUsage: TokenUsageSignal;
  interactionPattern: InteractionPatternSignal;
  interactionLeverage: "HIGH" | "MEDIUM" | "LOW";
}

export interface TokenUsageSignal {
  /** Total input tokens across session */
  inputTokens: number;
  /** Total output tokens across session */
  outputTokens: number;
  /** inputTokens + outputTokens */
  totalTokens: number;
  /** totalTokens / exchanges — derived ratio */
  tokensPerExchange: number;
  /** totalTokens / outcomes — derived ratio */
  tokensPerOutcome: number;
  /** Whether token data was found in the session */
  available: boolean;
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

export interface InteractionPatternSignal {
  /** User's interaction style with the agent */
  userStyle: "directive" | "collaborative" | "exploratory";
  /** How the user provides context to the agent */
  contextProvision: "structured" | "inline" | "vague";
  /** 1-2 sentence qualitative observation */
  observation: string;
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

// ── Activity event types (issue #10) ──────────────────────────

export interface MpgSessionEvent {
  schema_version: number;
  timestamp: string;
  event_type: "session_start" | "session_end" | "session_idle" | "session_resume" | "message_routed";
  session_id: string;
  project_key: string;
  project_dir: string;
  /** Only on session_end */
  duration_ms?: number;
  /** Only on message_routed */
  persona?: string;
}

export interface ActivitySession {
  session_id: string;
  project_key: string;
  project_dir: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  message_count: number;
  idle_count: number;
  resume_count: number;
}

export interface ActivitySummary {
  source: string;
  range_start: string;
  range_end: string;
  total_sessions: number;
  total_messages: number;
  avg_duration_ms: number | null;
  median_duration_ms: number | null;
  projects: Record<string, { sessions: number; messages: number }>;
  peak_concurrent: number;
}

export interface BucketedSessions {
  bucket_size: string;
  buckets: Array<{ bucket: string; session_count: number }>;
}

export interface GcResult {
  source: string;
  removed: number;
  retained: number;
  dry_run: boolean;
}
