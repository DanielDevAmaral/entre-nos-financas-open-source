export function llmConfig() {
  const groq = process.env.AI_PROVIDER === "groq";
  return {
    provider: groq ? "Groq" : "OpenAI",
    model: groq
      ? process.env.GROQ_MODEL || "openai/gpt-oss-120b"
      : process.env.OPENAI_MODEL || "",
    key: groq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY,
    ready: groq
      ? !!process.env.GROQ_API_KEY && process.env.GROQ_ZDR_CONFIRMED === "true"
      : process.env.AI_PROVIDER === "openai" &&
        !!process.env.OPENAI_API_KEY &&
        !!process.env.OPENAI_MODEL,
    url: groq
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/responses",
    groq,
  };
}
export function groqPayload(payload: {
  model: string;
  instructions: string;
  input: string;
  json?: boolean;
}) {
  return {
    model: payload.model,
    messages: [
      { role: "system", content: payload.instructions },
      { role: "user", content: payload.input },
    ],
    max_completion_tokens: 1200,
    reasoning_effort: "low",
    include_reasoning: false,
    ...(payload.json ? { response_format: { type: "json_object" } } : {}),
  };
}
export async function requestLlm(payload: {
  model: string;
  instructions: string;
  input: string;
  json?: boolean;
}) {
  const config = llmConfig();
  if (!config.ready || !config.key) throw new Error("Provider not configured");
  const { json, ...responsesPayload } = payload;
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify(
      config.groq
        ? groqPayload({ ...responsesPayload, json })
        : responsesPayload,
    ),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      response.status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_UNAVAILABLE",
    );
  const body = (await response.json()) as {
    status?: string;
    choices?: { finish_reason: string; message?: { content?: string } }[];
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  };
  if (config.groq) {
    const choice = body.choices?.[0];
    if (choice?.finish_reason !== "stop" || !choice.message?.content?.trim())
      throw new Error("Incomplete response");
    return choice.message.content.trim().slice(0, 6000);
  }
  const text = body.output
    ?.filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
  if (body.status !== "completed" || !text)
    throw new Error("Incomplete response");
  return text.slice(0, 6000);
}
