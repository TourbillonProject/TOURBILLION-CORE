import { defaultConfigPath, loadConfig, saveConfig, template } from './config.js';
import { connect, hello, pair } from './client.js';
import fs from 'node:fs';

/**
 * tourbillion-bridge — connects this computer to TOURBILLION CORE.
 *
 *   tourbillion-bridge init                       write a config template
 *   tourbillion-bridge pair --server URL --code C exchange a pairing code for a token
 *   tourbillion-bridge status                     show what this bridge offers
 *   tourbillion-bridge start                      connect and serve requests
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  const file = arg('config') ?? defaultConfigPath();
  switch (cmd) {
    case 'init': {
      if (fs.existsSync(file)) {
        console.log(`Config already exists: ${file}`);
        return;
      }
      saveConfig(template(), file);
      console.log(`Wrote ${file}\nEdit "roots", "blender" and "roblox" to match this computer, then pair.`);
      return;
    }
    case 'pair': {
      const server = arg('server');
      const code = arg('code');
      if (!server || !code) throw new Error('Usage: tourbillion-bridge pair --server https://host --code ABCD-EFGH');
      const cfg = fs.existsSync(file) ? loadConfig(file) : template();
      cfg.server = server;
      cfg.token = await pair(server, code);
      saveConfig(cfg, file);
      console.log(`Paired with ${server}. Token saved to ${file} (mode 600). Next: tourbillion-bridge start`);
      return;
    }
    case 'status': {
      const cfg = loadConfig(file);
      console.log(JSON.stringify({ server: cfg.server, paired: !!cfg.token, ...(await hello(cfg)).capabilities }, null, 2));
      return;
    }
    case 'start': {
      const cfg = loadConfig(file);
      const c = connect(cfg, (m) => console.log(`[${new Date().toISOString()}] ${m}`));
      process.on('SIGINT', () => {
        c.close();
        process.exit(0);
      });
      return;
    }
    default:
      console.log('Usage: tourbillion-bridge <init|pair|status|start> [--config path]');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
