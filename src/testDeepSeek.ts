import "dotenv/config";
import { describeError, getProviderEnvStatus, testDeepSeekConnection } from "./summarizeWithGemini.js";

async function main() {
  const envStatus = getProviderEnvStatus("deepseek");

  console.log("DeepSeek接続テスト");
  console.log(`- DEEPSEEK_API_KEY: ${envStatus.hasApiKey ? "読み込み済み" : "未設定"}`);
  console.log(`- DEEPSEEK_MODEL: ${envStatus.model}`);

  if (!envStatus.hasApiKey) {
    console.log("");
    console.log(".env または GitHub Secrets に DEEPSEEK_API_KEY を設定してください。APIキー本体はログには表示しません。");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await testDeepSeekConnection();
    console.log("- 接続結果: 成功");
    console.log(`- 応答: ${result.message ?? JSON.stringify(result)}`);
  } catch (error) {
    console.log("- 接続結果: 失敗");
    console.log(`- エラー詳細: ${describeError(error)}`);
    process.exitCode = 1;
  }
}

main();
