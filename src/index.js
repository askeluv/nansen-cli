#!/usr/bin/env node
/**
 * Nansen CLI - Command-line interface for Nansen API
 * Designed for AI agents with structured JSON output
 * 
 * Usage: nansen <command> [options]
 * 
 * All output is JSON for easy parsing by AI agents.
 * Use --pretty for human-readable formatting.
 * 
 * Core logic lives in cli.js for testability.
 */

import { runCLI } from './cli.js';

// Main entry point
runCLI(process.argv.slice(2));
