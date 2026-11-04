import { env } from "./config/env.js";
import { createAiGateway } from "./app.js";

function main(): void {
  const aiGateway = createAiGateway();

  console.log("================================");
  console.log("       AI QUALITY GATE");
  console.log("================================");
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`AI Provider: Gemini`);
  console.log(`AI Model: ${env.GEMINI_MODEL}`);
  console.log("AI Gateway: Initialized successfully.");
}

main();
