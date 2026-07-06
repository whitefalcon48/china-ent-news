# CLAUDE.md

このプロジェクトのエージェント向けガイドは `AGENTS.md` に一本化している。
**まず `AGENTS.md` を読み、作業前に `docs/roadmap.md` を確認すること。**

要点（詳細は AGENTS.md）:

- 編集方針の正本: `docs/editorial-character.md`
- 検証: `npm run check` → `npm run audit:sources`。AI 要約込みは GitHub Actions（deepseek）でのみ検証可能（ローカルは Gemini 不達）
- 守るライン: 官庁比率 ≦ 50% / 媒体 fresh > 0 / official-only topic は low / SNS 反応を捏造しない
- topicKey は `src/topicKey.ts` のみ。外部取得は graceful fallback 必須
