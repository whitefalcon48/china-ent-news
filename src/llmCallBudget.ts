export type LlmCallBudget = { limit: number; used: number };

export function createLlmCallBudget(limit = Number(process.env.LLM_CALL_BUDGET || 45)): LlmCallBudget {
  return {
    limit: Number.isFinite(limit) && limit >= 0 ? limit : 45,
    used: 0
  };
}

export function hasLlmBudgetRemaining(budget: LlmCallBudget): boolean {
  return budget.used < budget.limit;
}

export class LlmCallBudgetExceededError extends Error {
  constructor() {
    super("llm_call_budget_exceeded");
    this.name = "LlmCallBudgetExceededError";
  }
}

export function consumeLlmCall(budget: LlmCallBudget): void {
  if (!hasLlmBudgetRemaining(budget)) {
    throw new LlmCallBudgetExceededError();
  }
  budget.used += 1;
}
