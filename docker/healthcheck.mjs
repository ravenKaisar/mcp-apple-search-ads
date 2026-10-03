// Container health check: GET http://127.0.0.1:$PORT/health must return {"status":"ok"}.
// Uses Node's built-in fetch so the runtime image needs no curl/wget.
const port = process.env.PORT || '8080';
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  process.exit(response.ok && body.status === 'ok' ? 0 : 1);
} catch {
  process.exit(1);
}
