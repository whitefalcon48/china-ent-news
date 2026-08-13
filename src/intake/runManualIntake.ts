// Explicit GitHub Actions entrypoint. Keeping this separate avoids relying on
// TypeScript direct-execution detection, which can differ between local Node
// and the Actions loader.
import { runManualIntakeMain } from "./processManualIntake.js";

runManualIntakeMain().catch(() => {
  console.warn("manual intake fatal: manual_intake_processing_failed");
  process.exitCode = 1;
});
