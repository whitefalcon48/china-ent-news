import "dotenv/config";
import { describeError, getGeminiEnvStatus, testGeminiConnection } from "./summarizeWithGemini.js";

async function main() {
  const envStatus = getGeminiEnvStatus();

  console.log("Gemini接続テスト");
  console.log(`- GEMINI_API_KEY: ${envStatus.hasApiKey ? "読み込み済み" : "未設定"}`);
  console.log(`- GEMINI_MODEL: ${envStatus.model}`);

  if (!envStatus.hasApiKey) {
    console.log("");
    console.log(".env に GEMINI_API_KEY を設定してください。APIキー本体はログには表示しません。");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await testGeminiConnection();
    console.log("- 接続結果: 成功");
    console.log(`- 応答: ${result.message ?? JSON.stringify(result)}`);
  } catch (error) {
    console.log("- 接続結果: 失敗");
    console.log(`- エラー詳細: ${describeError(error)}`);
    process.exitCode = 1;
  }
}

main();
