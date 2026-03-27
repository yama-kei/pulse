export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
}

/**
 * Minimal OpenAI Chat Completions wrapper using built-in fetch.
 * Reads OPENAI_API_KEY from environment. Throws LlmUnavailableError
 * if no key is set. Supports OPENAI_BASE_URL override.
 */
export async function chatCompletion(
  model: string,
  messages: ChatMessage[],
  options?: { temperature?: number; timeout?: number }
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new LlmUnavailableError(
      "OPENAI_API_KEY not set — prompt effectiveness evaluation unavailable"
    );
  }

  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const url = `${baseUrl}/chat/completions`;
  const timeout = options?.timeout ?? 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new LlmUnavailableError(
        `OpenAI API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
      throw new LlmUnavailableError(
        "OpenAI API returned empty or malformed response"
      );
    }
    return choice.message.content;
  } finally {
    clearTimeout(timer);
  }
}
