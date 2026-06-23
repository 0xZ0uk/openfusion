// ---- Request types ----

export interface FusionConfig {
  /** Panel models (1-8). Defaults from env. */
  panel?: string[];
  /** Judge model. Defaults from env. */
  judge?: string;
  /** Outer model that writes the final answer. Omit to return judge analysis directly. */
  outer_model?: string;
  /** Max output tokens per inner panel/judge call. */
  max_tokens?: number;
  /** Sampling temperature for panel + outer model (judge uses low temp). */
  temperature?: number;
  /** Enable web search for panel and judge context. */
  web_search?: boolean;
}

export interface FusionRequest {
  model: string;
  messages: { role: string; content: string }[];
  fusion_config?: FusionConfig;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

// ---- Response types ----

export interface PanelResponse {
  model: string;
  content: string;
  error?: boolean;
}

export interface JudgeAnalysis {
  consensus: Array<{
    point: string;
    confidence: "high" | "medium" | "low";
    detail: string;
  }>;
  contradictions: Array<{
    topic: string;
    positions: Array<{ model: string; position: string }>;
    resolution: string;
  }>;
  coverage_gaps: Array<{
    topic: string;
    covered_by: string[];
    missed_by: string[];
    significance: string;
  }>;
  unique_insights: Array<{
    insight: string;
    source_model: string;
    why_notable: string;
  }>;
  blind_spots: Array<{
    topic: string;
    why_important: string;
    suggested_approach: string;
  }>;
  summary: string;
}

export interface PanelJudgeResult {
  panelResponses: PanelResponse[];
  analysis: JudgeAnalysis;
  judgeRawContent: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface FusionResult extends PanelJudgeResult {
  finalAnswer: string;
}

// ---- LiteLLM proxied request ----

export interface LiteLLMCompletionRequest {
  model: string;
  messages: { role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}
