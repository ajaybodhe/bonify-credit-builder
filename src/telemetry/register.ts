/**
 * Telemetry pre-loader.
 *
 * Loaded via Node's `--import` flag, NOT imported from application code:
 *
 *   node --import ./dist/telemetry/register.js dist/index.js
 *
 * Two reasons it has to work this way under ESM:
 *
 * 1. ESM evaluates every `import` in a module before any statement in that
 *    module runs. So `startTelemetry()` placed after the imports in index.ts
 *    would execute *after* fastify, pg and undici had already been loaded —
 *    too late to instrument them. It would look correct and silently produce
 *    no spans.
 * 2. Instrumentation patches modules through Node's loader hooks
 *    (import-in-the-middle). `--import` is what gets those hooks installed
 *    before the application graph is resolved.
 */
import { startTelemetry } from './otel.js';

startTelemetry();
