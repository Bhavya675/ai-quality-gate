import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;

  if (!apiKey || !model) {
    throw new Error("GEMINI_API_KEY or GEMINI_MODEL is missing from .env");
  }

  const ai = new GoogleGenAI({ apiKey });

  console.log("Connecting to Gemini...");
  console.log(`Model: ${model}`);

  try {
    const response = await ai.interactions.create({
      model,
      input: "Reply with exactly this sentence: Gemini connection successful.",
    });

    const output = response.output_text;

    if (!output || !output.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    console.log("\nGemini response:");
    console.log(output);
    console.log("\nGemini API connection verified.");
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error("\nGemini API Error:");
      console.error("Error type:", error.name);
      console.error("Message:", error.message);
    } else {
      console.error("\nGemini API failed with an unknown error.");
    }

    process.exitCode = 1;
  }
}

main();
