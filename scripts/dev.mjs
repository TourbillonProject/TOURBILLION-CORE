// Development: API server (tsx watch) + Vite dev server with proxy, in one terminal.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit', env: { ...process.env, TC_PORT: process.env.TC_PORT ?? '8787' } }),
  spawn('npm', ['run', 'dev', '-w', 'web'], { stdio: 'inherit', env: { ...process.env, TC_API: `http://localhost:${process.env.TC_PORT ?? '8787'}` } }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) { stop(); process.exit(code); } });
