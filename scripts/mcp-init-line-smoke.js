const { spawn } = require("child_process");
const path = require("path");

const SERVER_PATH = path.resolve(__dirname, "..", "mcp-server.js");
const TIMEOUT_MS = 8000;

function fail(message, details) {
  console.error(`❌ ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function pass(message) {
  console.log(`✅ ${message}`);
  process.exit(0);
}

const child = spawn(process.execPath, [SERVER_PATH], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let settled = false;

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill("SIGKILL");
  fail("Timed out waiting for line-delimited initialize response", stderr.trim());
}, TIMEOUT_MS);

function cleanup() {
  clearTimeout(timeout);
  if (!child.killed) child.kill("SIGTERM");
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (/^content-length\s*:/i.test(trimmed)) {
    settled = true;
    cleanup();
    fail("Expected line-delimited JSON response, got framed header", trimmed);
    return;
  }

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    settled = true;
    cleanup();
    fail("Line response was not valid JSON", String(err));
    return;
  }

  if (msg?.jsonrpc !== "2.0") {
    settled = true;
    cleanup();
    fail("Invalid JSON-RPC version in line response", trimmed);
    return;
  }

  if (msg?.error) {
    settled = true;
    cleanup();
    fail("Server returned JSON-RPC error", JSON.stringify(msg.error));
    return;
  }

  if (msg.id !== 1) {
    settled = true;
    cleanup();
    fail("Unexpected response id in line response", trimmed);
    return;
  }

  const protocolVersion = msg?.result?.protocolVersion;
  const serverName = msg?.result?.serverInfo?.name;
  if (!protocolVersion || !serverName) {
    settled = true;
    cleanup();
    fail("Initialize line response missing expected fields", trimmed);
    return;
  }

  settled = true;
  cleanup();
  pass(`Line-delimited initialize OK (${serverName} ${protocolVersion})`);
}

child.stdout.on("data", (chunk) => {
  if (settled) return;
  stdout += chunk.toString("utf8");

  let newlineIndex;
  while ((newlineIndex = stdout.indexOf("\n")) !== -1) {
    const line = stdout.slice(0, newlineIndex);
    stdout = stdout.slice(newlineIndex + 1);
    handleLine(line);
    if (settled) return;
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.on("error", (err) => {
  if (settled) return;
  settled = true;
  cleanup();
  fail("Failed to launch MCP server", String(err));
});

child.on("exit", (code) => {
  if (settled) return;
  settled = true;
  cleanup();
  fail(`MCP server exited before line initialize response (code ${code})`, stderr.trim());
});

const initMessage = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {},
});

child.stdin.write(initMessage + "\n");
