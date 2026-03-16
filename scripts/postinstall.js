#!/usr/bin/env node

/**
 * Post-install onboarding for nansen-cli.
 *
 * Runs after `npm install -g nansen-cli` and offers two optional steps:
 *   1. Install the Nansen AI coding skill (`npx skills add nansen-ai/nansen-cli`)
 *   2. Check account status to verify the API key works (0 credits)
 *
 * Non-interactive environments (CI, piped stdin) get a one-liner tip instead.
 * Always exits 0 — onboarding failures must never break installation.
 */

import { createInterface } from "readline";
import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const SKILL_REPO = "nansen-ai/nansen-cli";
const TEST_QUERY = ["account"];
const TEST_QUERY_DISPLAY = "nansen account";

// Path to the CLI entry point (works even if `nansen` bin isn't linked yet)
const CLI_ENTRY = join(__dirname, "..", "src", "index.js");

function log(msg = "") {
  process.stderr.write(`  ${msg}\n`);
}

function hasTTY() {
  return process.stdin.isTTY && process.stderr.isTTY;
}

function hasNpx() {
  try {
    execFileSync("npx", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
}

function isLoggedIn() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configFile = join(home, ".nansen", "config.json");
  if (!existsSync(configFile)) return false;
  try {
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    return !!(config.apiKey || config.api_key);
  } catch {
    return false;
  }
}

function isSkillInstalled() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const locations = [
    join(home, ".claude", "skills", "nansen-cli"),
    join(home, ".claude", "skills", "nansen-ai--nansen-cli"),
  ];
  return locations.some((loc) => existsSync(loc));
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;
    rl.on("close", () => { if (!answered) resolve(""); });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function installSkill() {
  if (isSkillInstalled()) {
    log(`${GREEN}✓${RESET} Nansen skill already installed.`);
    return;
  }

  if (!hasNpx()) {
    log(`${DIM}Tip: Run 'npx skills add ${SKILL_REPO}' to install the Nansen AI coding skill.${RESET}`);
    return;
  }

  log(`The Nansen skill lets AI coding agents (Cursor, Claude Code, etc.) query`);
  log(`on-chain data, track smart money, and analyze tokens on your behalf.`);
  const answer = await prompt(`  Install Nansen skill for your AI coding agent? [Y/n] `);

  if (/^n/i.test(answer)) {
    log(`Skipped. You can install it later with: ${CYAN}npx skills add ${SKILL_REPO}${RESET}`);
    return;
  }

  log(`Installing Nansen skill...`);
  const ok = await runCommand("npx", ["-y", "skills", "add", SKILL_REPO]);
  if (!ok) {
    log(`${YELLOW}Skill installation failed. You can retry with: npx skills add ${SKILL_REPO}${RESET}`);
  }
}

async function testQuery() {
  if (!isLoggedIn()) {
    log();
    log(`Not logged in yet. Run ${CYAN}nansen login --api-key <key>${RESET} to authenticate.`);
    log(`Get your API key at: ${CYAN}https://app.nansen.ai/api${RESET}`);
    return;
  }

  log();
  log(`Your API key is configured. Let's verify it works.`);
  const answer = await prompt(`  Check account status? (${DIM}${TEST_QUERY_DISPLAY}${RESET}) [Y/n] `);

  if (/^n/i.test(answer)) {
    log(`Skipped. You're all set! Try: ${CYAN}nansen research smart-money netflow --chain solana${RESET}`);
    return;
  }

  log(`Running: ${DIM}${TEST_QUERY_DISPLAY}${RESET}`);
  log();
  // Use process.execPath + CLI_ENTRY so it works even if `nansen` bin isn't linked yet
  const ok = await runCommand(process.execPath, [CLI_ENTRY, ...TEST_QUERY, "--pretty"]);
  if (ok) {
    log();
    log(`${GREEN}✓${RESET} All set! Run ${CYAN}nansen help${RESET} to see all available commands.`);
  } else {
    log();
    log(`${YELLOW}Query failed. Check your API key with: nansen login --api-key <key>${RESET}`);
  }
}

async function main() {
  // Only run for global installs; skip local npm install / npm ci
  if (process.env.npm_lifecycle_event === "postinstall" && process.env.npm_config_global !== "true") {
    return;
  }

  log();

  if (!hasTTY()) {
    log(`${BOLD}Nansen CLI installed!${RESET}`);
    log();
    log(`Tip: Run '${CYAN}npx skills add ${SKILL_REPO}${RESET}' to install the Nansen AI coding skill.`);
    log(`Tip: Run '${CYAN}nansen login --api-key <key>${RESET}' to authenticate.`);
    return;
  }

  log(`${BOLD}Nansen CLI installed!${RESET}`);
  log();

  await installSkill();
  await testQuery();

  log();
}

main().catch(() => {
  // Never fail installation due to onboarding errors
});
