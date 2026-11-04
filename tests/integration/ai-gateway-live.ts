import { createAiGateway } from "../../src/app.js";

async function main(): Promise<void> {
  const gateway = createAiGateway();

  console.log("Sending a test request through AiGateway...");

  try {
    const response = await gateway.review({
      requestId: "local-test-001",
      repository: "demo/ai-quality-gate",
      pullRequestNumber: 1,
      baseSha: "base-sha-test",
      headSha: "head-sha-test",
      systemPrompt: [
        "You are a senior software code reviewer.",
        "Review the supplied code for correctness.",
        "Do not invent issues.",
        "Keep your response concise.",
      ].join("\n"),
      userPrompt: [
        "Review this TypeScript function:",
        "",
        "function divide(a: number, b: number): number {",
        "  return a / b;",
        "}",
        "",
        "Identify any genuine correctness issue.",
      ].join("\n"),
      maxTokens: 1024,
    });

    console.log("\nGateway response received.");
    console.log("Provider:", response.provider);
    console.log("Model:", response.model);
    console.log("Response:");
    console.log(response.content);

    console.log("\nAI Gateway integration test passed.");
  } catch (error: unknown) {
    console.error("\nAI Gateway integration test failed.");

    if (error instanceof Error) {
      console.error("Error type:", error.name);
      console.error("Message:", error.message);
    }

    process.exitCode = 1;
  }
}

main();
