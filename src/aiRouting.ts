import type { AiProvider } from "./types.js";

export type AiStage = "base" | "ledger" | "comment";

export type ResolvedStageAi = {
  provider: AiProvider;
  model?: string;
};

export function resolveStageAi(stage: AiStage, baseProvider: AiProvider): ResolvedStageAi {
  if (stage === "base") return { provider: baseProvider, model: undefined };
  const prefix = stage === "ledger" ? "LEDGER" : "COMMENT";
  const configuredProvider = process.env[`${prefix}_AI_PROVIDER`]?.trim().toLowerCase();
  const provider = configuredProvider === "deepseek" || configuredProvider === "gemini"
    ? configuredProvider
    : baseProvider;
  const model = process.env[`${prefix}_AI_MODEL`]?.trim() || undefined;
  return { provider, model };
}

export function resolveModelName(provider: AiProvider, model?: string) {
  if (model?.trim()) return model.trim();
  return provider === "deepseek"
    ? process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
    : process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
}

export function resolveAiModels(baseProvider: AiProvider) {
  const base = resolveStageAi("base", baseProvider);
  const ledger = resolveStageAi("ledger", baseProvider);
  const comment = resolveStageAi("comment", baseProvider);
  return {
    base: { provider: base.provider, model: resolveModelName(base.provider, base.model) },
    ledger: { provider: ledger.provider, model: resolveModelName(ledger.provider, ledger.model) },
    comment: { provider: comment.provider, model: resolveModelName(comment.provider, comment.model) }
  };
}
