function asError(reason, fallback) {
  if (reason instanceof Error) return reason;
  return new Error(String(reason || fallback));
}

// A plain `await once(stream, 'drain')` can hang forever if cancellation
// destroys the stream while it is backpressured: Node emits `close`, not
// `drain`. Provider completions own limiter/resource cleanup, so drain waits
// must also terminate on abort, stream error, or close.
export function waitForWritableDrain(stream, signal = null, label = 'Audio output stream') {
  if (!stream || stream.destroyed) return Promise.reject(new Error(`${label} closed before backpressure drained.`));
  if (signal?.aborted) return Promise.reject(asError(signal.reason, `${label} cancelled while waiting for backpressure.`));

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener?.('drain', onDrain);
      stream.removeListener?.('error', onError);
      stream.removeListener?.('close', onClose);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onError = (error) => finish(reject, asError(error, `${label} failed while waiting for backpressure.`));
    const onClose = () => finish(
      reject,
      signal?.aborted
        ? asError(signal.reason, `${label} cancelled while waiting for backpressure.`)
        : new Error(`${label} closed before backpressure drained.`)
    );
    const onAbort = () => finish(reject, asError(signal?.reason, `${label} cancelled while waiting for backpressure.`));

    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // Close the tiny race between the pre-check and listener registration.
    if (signal?.aborted) onAbort();
    else if (stream.destroyed) onClose();
  });
}
