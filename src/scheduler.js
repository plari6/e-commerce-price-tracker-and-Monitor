// Daemon mode: node-cron runs the check on CHECK_CRON; optional /health endpoint for Docker or uptime monitors.
import http from 'node:http';
import cron from 'node-cron';
import { runCheck } from './monitor.js';

export async function startScheduler(store, { settings, env = process.env, runNow = false, log = console.log, healthPort } = {}) {
  if (!cron.validate(settings.cron)) throw new Error(`Invalid CHECK_CRON "${settings.cron}" (example: "0 8 * * *" = every day at 08:00)`);
  let running = false;
  let last = null;

  const run = async (why) => {
    if (running) { log(`[${stamp()}] previous check still running, skipping this tick`); return; }
    running = true;
    log(`[${stamp()}] price check started (${why})`);
    try {
      last = await runCheck(store, { settings, env, log });
      log(`[${stamp()}] done: ${last.ok}/${last.checked} ok, ${last.alerts} alerts, ${last.failed} failed`);
    } catch (err) {
      log(`[${stamp()}] check crashed: ${err.message}`);
      last = { error: err.message, at: new Date().toISOString() };
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(settings.cron, () => run('schedule'), { timezone: settings.timezone, name: 'price-check' });
  log(`Scheduler on: "${settings.cron}" (${settings.timezone}). ${store.listProducts({ activeOnly: true }).length} active products. Ctrl+C to stop.`);
  try {
    const next = task.getNextRun?.();
    if (next) log(`Next run: ${next.toLocaleString()}`);
  } catch { /* older node-cron */ }

  let server = null;
  if (healthPort) {
    server = http.createServer((req, res) => {
      const lastRun = store.lastRun();
      res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running, cron: settings.cron, lastRun, lastSummary: last && { ok: last.ok, failed: last.failed, alerts: last.alerts, checked: last.checked } }));
    }).listen(healthPort, () => log(`Health endpoint: http://localhost:${healthPort}/health`));
  }

  if (runNow) await run('startup');

  const stop = async () => {
    task.stop();
    server?.close();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { task, run, stop };
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
