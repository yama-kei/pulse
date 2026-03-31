export interface PulseReport {
  timestamp: string;
  project: string;
  cwd: string;
  convergence: ConvergenceSignal;
  intentAnchoring: IntentAnchoringSignal;
  decisionQuality: DecisionQualitySignal;
  tokenUsage: TokenUsageSignal;
  interactionPattern: InteractionPatternSignal;
  promptEffectiveness: PromptEffectivenessSignal;
  interactionLeverage: "HIGH" | "MEDIUM" | "LOW";
  leverageScore: number;
}

export interface AgentReport {
  role: string;
  sessionPath: string;
  report: PulseReport;
}

export interface ThreadPulseReport {
  timestamp: string;
  worktreeId: string;
  project: string;
  agents: AgentReport[];
  aggregate: PulseReport;
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
  /** Commits referencing the same issue as a prior commit (not counted as outcomes) */
  duplicateCommits: number;
  /** Consecutive fix-fail cycles without diagnosis in between (#30 approach A) */
  blindRetries: number;
  /** Whether user pivoted from direct fixes to structured debugging mid-session (#30 approach B) */
  pivot: PivotSignal | null;
  /** Per-agent convergence breakdown (only present when MPG data available) */
  agentBreakdown?: AgentConvergenceStats[];
}

export interface PivotSignal {
  /** Exchange index (0-based) where the pivot occurred */
  atExchange: number;
  /** What the user pivoted to */
  type: "issue_creation" | "root_cause_request";
  /** Number of fix attempts before the pivot */
  fixAttemptsBefore: number;
}

export interface AgentConvergenceStats {
  /** Agent identifier (e.g. "engineer", "pm", "qa") */
  agent: string;
  /** Messages routed to this agent */
  messages: number;
  /** Errors attributed to this agent */
  errors: number;
  /** Error rate as percentage */
  errorRate: number;
  /** Convergence penalty from errors (added to effective rate) */
  convergencePenalty: number;
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
  /** Handoff pattern data (only present when MPG data available) */
  handoffs?: HandoffPatternStats;
}

export interface HandoffPatternStats {
  /** Total number of agent handoffs in the session */
  totalHandoffs: number;
  /** Distinct handoff pairs (e.g. "pm→engineer") with frequency */
  handoffPairs: Array<{ from: string; to: string; count: number }>;
  /** "pipeline" = mostly linear (A→B→C), "iterative" = frequent back-and-forth */
  pattern: "pipeline" | "iterative" | "single-agent";
}

/** Behavioral event extracted from a user message by LLM */
export interface PromptEvent {
  /** Which user message (0-indexed) this event was extracted from */
  messageIndex: number;
  /** Classification of the user's behavior */
  eventType:
    | "PROVIDED_CONTEXT"
    | "SCOPED_REQUEST"
    | "VAGUE_REQUEST"
    | "CORRECTED_AGENT"
    | "REFINED_INTENT"
    | "DECOMPOSED_TASK"
    | "ACCEPTED_WITHOUT_REVIEW"
    | "GAVE_ACTIONABLE_FEEDBACK"
    | "GAVE_VAGUE_FEEDBACK"
    | "SCOPE_CREPT";
  /** Brief explanation of why this classification was chosen */
  reasoning: string;
}

/** Scores for each effectiveness dimension (0.0 to 1.0) */
export interface EffectivenessScores {
  /** Ratio of messages that proactively provide context */
  contextProvision: number;
  /** Ratio of scoped vs vague requests */
  scopeDiscipline: number;
  /** Ratio of actionable vs vague feedback */
  feedbackQuality: number;
  /** Presence of task decomposition in complex sessions */
  decomposition: number;
  /** Inverse of uncritical acceptance rate */
  verification: number;
}

export interface PromptEffectivenessSignal {
  /** Whether LLM evaluation was performed */
  available: boolean;
  /** Extracted behavioral events from user messages */
  events: PromptEvent[];
  /** Scores per dimension (0.0 = poor, 1.0 = excellent) */
  scores: EffectivenessScores;
  /** Weighted overall score (0.0 to 1.0) */
  overallScore: number;
  /** Human-readable label */
  rating: "excellent" | "good" | "moderate" | "developing";
  /** 1-2 sentence observation */
  observation: string;
  /** Actionable coaching tips based on weak dimensions */
  coaching: string[];
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
  event_type: "session_start" | "session_end" | "session_idle" | "session_resume" | "message_routed" | "agent_handoff";
  session_id: string;
  project_key: string;
  project_dir: string;
  /** Only on session_end */
  duration_ms?: number;
  /** Only on message_routed */
  persona?: string;
  /** Target agent for routed messages or handoffs */
  agent_target?: string;
  /** Whether the event resulted in an error */
  is_error?: boolean;
  /** Error classification when is_error is true */
  error_type?: string;
  /** Source agent for agent_handoff events */
  agent_source?: string;
  /** How the message was routed (e.g. "direct", "round-robin", "capability") */
  routing_method?: string;
}

/** MPG events correlated to a specific Claude session */
export interface CorrelatedMpgData {
  sessionId: string;
  events: MpgSessionEvent[];
}

export interface TimeBucket {
  bucket: string;
  count: number;
}

export interface PersonaCount {
  agent: string;
  count: number;
}

export interface PeakBucket {
  bucket: string;
  max_concurrent: number;
}

export interface DurationStat {
  project_key: string;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;
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
  sessions_per_bucket: TimeBucket[];
  message_volume: TimeBucket[];
  persona_breakdown: PersonaCount[];
  peak_concurrent_series: PeakBucket[];
  duration_stats: DurationStat[];
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
