import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('Usage: node scripts/run-logged.mjs <command> [args...]\n');
  process.exit(2);
}

const { writeDevLog } = await import('../server/dev-logger.mjs');
const child = spawn(command, args, {
  cwd: projectRoot,
  env: { ...process.env, DEBUG_STDIO_CAPTURE: 'true' },
  stdio: ['inherit', 'pipe', 'pipe'],
});

function tee(stream, output, defaultLevel, source) {
  let remainder = '';
  stream.on('data', chunk => {
    output.write(chunk);
    const parts = `${remainder}${chunk}`.split(/\r?\n/);
    remainder = parts.pop() || '';
    for (const line of parts) {
      if (line) {
        const level = defaultLevel === 'error' && /warning|trace-warnings/i.test(line) ? 'warn' : defaultLevel;
        writeDevLog(level, source, line);
      }
    }
  });
  stream.on('end', () => {
    if (remainder) {
      const level = defaultLevel === 'error' && /warning|trace-warnings/i.test(remainder) ? 'warn' : defaultLevel;
      writeDevLog(level, source, remainder);
    }
  });
}

tee(child.stdout, process.stdout, 'info', `${path.basename(command)}.stdout`);
tee(child.stderr, process.stderr, 'error', `${path.basename(command)}.stderr`);

child.on('error', error => {
  writeDevLog('error', 'command.spawn', error.message, { stack: error.stack });
  process.stderr.write(`${error.message}\n`);
});
child.on('close', (code, signal) => {
  const expectedSignal = signal === 'SIGINT' || signal === 'SIGTERM';
  writeDevLog(code === 0 || expectedSignal ? 'info' : 'error', 'command.exit', `${command} exited`, { code, signal });
  process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
