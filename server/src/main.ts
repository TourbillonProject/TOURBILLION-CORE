import './bootstrap/warnings.js';
import { buildApp } from './app.js';
import { SYSTEM_NAME } from '@tc/shared';

const { app, ctx, close } = await buildApp({}, { logger: true });

const setupCode = ctx.auth.ensureSetupCode();
await app.listen({ host: ctx.config.host, port: ctx.config.port });

const line = '─'.repeat(64);
console.log(`\n${line}\n  ${SYSTEM_NAME} online — http://${ctx.config.host === '0.0.0.0' ? 'localhost' : ctx.config.host}:${ctx.config.port}`);
if (ctx.config.publicUrl) console.log(`  Public URL: ${ctx.config.publicUrl}`);
if (setupCode) {
  console.log(`\n  FIRST-RUN SETUP CODE:  ${setupCode}`);
  console.log(`  (also saved to ${ctx.config.dataDir}/setup-code.txt — needed once to create your passphrase)`);
}
if (!ctx.ai.isReady()) console.log('\n  Claude is not connected yet: add an Anthropic API key in Connected Apps → Claude.');
console.log(`${line}\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${SYSTEM_NAME} shutting down…`);
    void close().then(() => process.exit(0));
  });
}
