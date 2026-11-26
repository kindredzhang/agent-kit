export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  error: Error;
}

export interface RetryPolicy {
  maxAttempts: number;
  delayMs?: number;
  shouldRetry?: (context: RetryContext) => boolean | Promise<boolean>;
}

export function assertRetryPolicy(policy: RetryPolicy, label: string): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) {
    throw new RangeError(`${label}.maxAttempts must be an integer between 1 and 10.`);
  }
  if (policy.delayMs !== undefined && (!Number.isSafeInteger(policy.delayMs) || policy.delayMs < 0)) {
    throw new RangeError(`${label}.delayMs must be a non-negative safe integer.`);
  }
  if (policy.shouldRetry !== undefined && typeof policy.shouldRetry !== "function") {
    throw new TypeError(`${label}.shouldRetry must be a function.`);
  }
}

export function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The run was cancelled.", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The run was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
