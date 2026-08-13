import assert from "node:assert/strict";
import { buildDeepSeekJsonRequest } from "./deepSeekRequest.js";

const request = buildDeepSeekJsonRequest("deepseek-v4-pro", "JSONで返してください", 8000, 0);

assert.deepEqual(request.thinking, { type: "disabled" });
assert.equal(request.max_tokens, 8000);
assert.equal(request.temperature, 0);
assert.deepEqual(request.response_format, { type: "json_object" });
assert.equal(request.messages[0]?.content, "JSONで返してください");
console.log("DeepSeek structured JSON request tests passed");
