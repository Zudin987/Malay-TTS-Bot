// Local ownership must end even when a remote API ignores AbortSignal.
export function cancellationError(reason, message = 'Operation cancelled.') {
  if (reason?.budgetLike) return reason;
  const error = new Error(reason instanceof Error ? reason.message : String(reason || message), { cause: reason });
  error.name = 'AbortError';
  error.cancelled = true;
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : cancellationError(signal.reason);
}

export function discardGenerated(value, reason = cancellationError()) {
  try { Promise.resolve(value?.cancel?.(reason)).catch(() => {}); } catch {}
  try { value?.audioStream?.destroy?.(); } catch {}
  try { Promise.resolve(value?.body?.cancel?.(reason)).catch(() => {}); } catch {}
}

export function raceWithSignal(work, signal, onLate = null) {
  const promise = Promise.resolve(work);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : cancellationError(signal.reason));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      if (settled) {
        try { Promise.resolve(onLate?.(value, signal.reason)).catch(() => {}); } catch {}
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

export function deadlineSignal(parent, milliseconds, error) {
  const controller = new AbortController();
  const cancel = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  const onAbort = () => cancel(cancellationError(parent.reason));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel(error), Math.max(1, milliseconds));
  timer.unref?.();
  return {
    signal: controller.signal, cancel,
    cleanup() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); }
  };
}

export async function readResponseBuffer(response, { signal, maxBytes }) {
  throwIfAborted(signal);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await raceWithSignal(response.arrayBuffer(), signal));
    if (bytes.length > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes.`);
    return bytes;
  }
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await raceWithSignal(reader.read(), signal);
      throwIfAborted(signal);
      if (done) break;
      bytes += value?.length || 0;
      if (bytes > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes.`);
      if (value?.length) parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, bytes);
  } catch (error) {
    try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
