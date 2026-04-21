import { spawn } from 'node:child_process';

const rawPort = Number.parseInt(process.env.PERF_PORT ?? '4174', 10);
const port = Number.isFinite(rawPort) && rawPort > 0 ? String(rawPort) : '4174';
const host = '127.0.0.1';

const args = ['preview', '--strictPort', '--host', host, '--port', port];
const child = spawn('vite', args, { stdio: 'inherit', shell: true });

child.on('exit', (code) => {
  process.exit(typeof code === 'number' ? code : 1);
});
