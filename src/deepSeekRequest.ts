export function buildDeepSeekJsonRequest(model: string, prompt: string, maxTokens = 8192, temperature = 0.1) {
  return {
    model,
    // DeepSeek V4 enables thinking by default. For JSON extraction/generation,
    // reasoning tokens can exhaust max_tokens before message.content begins.
    thinking: { type: "disabled" as const },
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" as const },
    messages: [{ role: "user" as const, content: prompt }]
  };
}
