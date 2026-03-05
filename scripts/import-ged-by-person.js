#!/usr/bin/env node

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const DEFAULT_ENDPOINT = "http://localhost:3333/capture";
const DEFAULT_DELAY_MS = 75;
const DEFAULT_RETRIES = 3;

function parseArgs(argv) {
  const args = {
    endpoint: DEFAULT_ENDPOINT,
    delayMs: DEFAULT_DELAY_MS,
    retries: DEFAULT_RETRIES,
    dryRun: false,
    limit: null,
    file: null,
    key: process.env.MCP_ACCESS_KEY || "",
    source: "gedcom-import",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--file" || token === "-f") {
      args.file = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (token === "--key" || token === "-k") {
      args.key = argv[i + 1] || "";
      i += 1;
      continue;
    }

    if (token === "--endpoint" || token === "-e") {
      args.endpoint = argv[i + 1] || DEFAULT_ENDPOINT;
      i += 1;
      continue;
    }

    if (token === "--delay-ms") {
      args.delayMs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (token === "--retries") {
      args.retries = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (token === "--limit") {
      args.limit = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (token === "--source") {
      args.source = argv[i + 1] || "gedcom-import";
      i += 1;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (!token.startsWith("-") && !args.file) {
      args.file = token;
    }
  }

  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/import-ged-by-person.js --file /path/to/tree.ged [options]

Options:
  --file, -f      Path to GEDCOM file
  --key, -k       MCP access key (defaults to MCP_ACCESS_KEY env var)
  --endpoint, -e  Capture endpoint (default: ${DEFAULT_ENDPOINT})
  --delay-ms      Delay between requests (default: ${DEFAULT_DELAY_MS})
  --retries       Retries per request on 429/5xx (default: ${DEFAULT_RETRIES})
  --limit         Only send first N people
  --source        metadata.source value (default: gedcom-import)
  --dry-run       Parse and print sample, do not send
  --help, -h      Show help
`);
}

function cleanName(rawName) {
  if (!rawName) return "Unknown";
  return rawName.replace(/\//g, "").replace(/\s+/g, " ").trim() || "Unknown";
}

function extractIndividuals(gedText) {
  const lines = gedText.split(/\r?\n/);
  const people = [];

  let current = null;

  for (const line of lines) {
    const indiStart = line.match(/^0\s+@([^@]+)@\s+INDI\s*$/);
    if (indiStart) {
      if (current) people.push(current);
      current = {
        xref: indiStart[1],
        lines: [line],
        rawName: null,
      };
      continue;
    }

    if (line.startsWith("0 ")) {
      if (current) {
        people.push(current);
        current = null;
      }
      continue;
    }

    if (!current) continue;

    current.lines.push(line);

    if (!current.rawName) {
      const nameMatch = line.match(/^1\s+NAME\s+(.+)$/);
      if (nameMatch) current.rawName = nameMatch[1].trim();
    }
  }

  if (current) people.push(current);

  return people.map((person) => {
    const displayName = cleanName(person.rawName);
    const chunk = [
      `GEDCOM Person ${person.xref}: ${displayName}`,
      ...person.lines,
    ].join("\n");

    return {
      xref: person.xref,
      name: displayName,
      content: chunk,
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postCapture({ endpoint, key, content, source, retries }) {
  let attempt = 0;

  while (attempt <= retries) {
    attempt += 1;

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-brain-key": key,
        },
        body: JSON.stringify({ content, source }),
      });
    } catch (error) {
      if (attempt > retries) throw error;
      await sleep(250 * attempt);
      continue;
    }

    if (res.ok) return res.json();

    const bodyText = await res.text().catch(() => "");
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt > retries) {
      throw new Error(`HTTP ${res.status} ${bodyText}`.trim());
    }

    await sleep(300 * attempt);
  }

  throw new Error("Unexpected retry loop termination");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  if (!args.file) {
    console.error("Missing required --file argument.");
    usage();
    process.exit(1);
  }

  if (!args.dryRun && !args.key) {
    console.error("Missing MCP access key. Use --key or set MCP_ACCESS_KEY.");
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`GEDCOM file not found: ${filePath}`);
    process.exit(1);
  }

  const gedText = fs.readFileSync(filePath, "utf8");
  let people = extractIndividuals(gedText);

  if (args.limit && Number.isFinite(args.limit) && args.limit > 0) {
    people = people.slice(0, args.limit);
  }

  if (!people.length) {
    console.error("No INDI records found in GEDCOM file.");
    process.exit(1);
  }

  console.log(`Found ${people.length} person records.`);

  if (args.dryRun) {
    const first = people[0];
    console.log("Dry run enabled. First person chunk preview:");
    console.log("--------------------------------------------");
    console.log(first.content);
    console.log("--------------------------------------------");
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < people.length; i += 1) {
    const person = people[i];
    const label = `${i + 1}/${people.length} ${person.xref} ${person.name}`;

    try {
      const result = await postCapture({
        endpoint: args.endpoint,
        key: args.key,
        content: person.content,
        source: args.source,
        retries: args.retries,
      });

      successCount += 1;
      console.log(`OK   ${label} -> ${result.id}`);
    } catch (error) {
      failureCount += 1;
      console.error(`FAIL ${label} -> ${error.message}`);
    }

    if (args.delayMs > 0 && i < people.length - 1) {
      await sleep(args.delayMs);
    }
  }

  console.log(`Done. Success: ${successCount}, Failed: ${failureCount}`);

  if (failureCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Import failed:", error.message);
  process.exit(1);
});
