/**
 * Loaded via `node --import`, never imported from application code: ESM evaluates
 * imports before statements, so calling this from index.ts would run it after
 * fastify, pg and undici had loaded — too late to instrument them.
 */
import { startTelemetry } from './otel.js';

startTelemetry();
