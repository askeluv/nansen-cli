#!/usr/bin/env node
/**
 * Nansen CLI - Command-line interface for Nansen API
 * Designed for AI agents.
 *
 * Usage: nansen <command> [options]
 *
 * Research commands return JSON; operational commands print human-readable text.
 * Use --pretty for human-readable formatting.
 * 
 * Core logic lives in cli.js for testability.
 */

import { runCLI } from './cli.js';

// Main entry point
await runCLI(process.argv.slice(2));
