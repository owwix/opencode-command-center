import { createServer } from "node:http";

// Deliberately deterministic, unpaid model fixture. This tests the harness
// protocol and tools, not the quality of any model or an independent reviewer.
createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    response.writeHead(400).end();
    return;
  }
  const review = body.messages?.some((message) =>
    JSON.stringify(message.content).includes("REVIEW_FIXTURE")
  );
  if (JSON.stringify(body.messages).includes("IMAGE_FIXTURE")) {
    const received = body.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "image_url" &&
            part.image_url?.url?.startsWith("data:image/png;base64,")
        )
    );
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "image-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { content: received ? "IMAGE_BYTES_RECEIVED" : "IMAGE_MISSING" }, finish_reason: null }] })}\n\n`
    );
    response.end(
      `data: ${JSON.stringify({ id: "image-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    );
    return;
  }
  if (
    body.messages?.some((message) =>
      JSON.stringify(message.content).includes("SLOW_FIXTURE")
    )
  )
    await new Promise((done) => setTimeout(done, 15000));
  const hasTool = body.messages?.some((message) => message.role === "tool");
  const tool = review ? "read" : "write";
  const args = review
    ? { filePath: "/workspace/result.txt" }
    : {
        filePath: "/workspace/result.txt",
        content: "verified fixture output\n"
      };
  const available = body.tools?.map((entry) => entry.function?.name) ?? [];
  if (!hasTool && !available.includes(tool)) {
    console.error(`Missing ${tool} tool; available: ${available.join(",")}`);
    response
      .writeHead(400)
      .end(JSON.stringify({ error: { message: `Missing ${tool} tool` } }));
    return;
  }
  const final = review
    ? {
        protocol: "quality-review/v1",
        status: "pass",
        summary: "Fixture read completed",
        findings: [],
        riskEvidence: {
          security: { status: "not_applicable", evidence: [] },
          deployment: { status: "not_applicable", evidence: [] }
        }
      }
    : {
        protocol: "quality-result/v1",
        status: "complete",
        summary: "Fixture file written",
        changedFiles: ["result.txt"],
        checks: [],
        blockers: []
      };
  const delta = hasTool
    ? { content: JSON.stringify(final) }
    : {
        tool_calls: [
          {
            index: 0,
            id: "fixture-call",
            type: "function",
            function: { name: tool, arguments: JSON.stringify(args) }
          }
        ]
      };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (value) =>
    response.write(
      `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture", ...value })}\n\n`
    );
  send({ choices: [{ index: 0, delta, finish_reason: null }] });
  send({
    choices: [
      { index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  });
  response.end("data: [DONE]\n\n");
}).listen(8799, "0.0.0.0");
