const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS || 30000);

function waitForDrain(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', handleDrain);
      res.removeListener('close', handleClose);
      res.removeListener('error', handleError);
    };
    const handleDrain = () => { cleanup(); resolve(); };
    const handleClose = () => { cleanup(); reject(new Error('client disconnected')); };
    const handleError = error => { cleanup(); reject(error); };
    res.once('drain', handleDrain);
    res.once('close', handleClose);
    res.once('error', handleError);
  });
}

export async function pipeWebBodyToNode(body, res, { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) {
  if (!body) return;
  const reader = body.getReader();
  let closed = false;
  const handleClose = () => {
    closed = true;
    reader.cancel().catch(() => {});
  };
  res.once('close', handleClose);

  try {
    while (!closed) {
      let timeout;
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('upstream stream idle timeout')), idleTimeoutMs);
        })
      ]).finally(() => clearTimeout(timeout));
      if (result.done) break;
      if (!res.write(result.value)) {
        await waitForDrain(res);
      }
    }
  } finally {
    res.removeListener('close', handleClose);
    if (closed) await reader.cancel().catch(() => {});
  }
}
