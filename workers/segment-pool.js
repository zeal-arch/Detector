class SegmentPool {

  constructor(concurrency = 4, maxRetries = 3) {
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this._queue = [];
    this._active = 0;
    this._aborted = false;
  }

  fetch(url, index, options = {}) {
    if (this._aborted) return Promise.reject(new Error("Pool aborted"));

    return new Promise((resolve, reject) => {
      this._queue.push({ url, index, options, resolve, reject, retries: 0 });
      this._processQueue();
    });
  }

  _processQueue() {
    while (
      this._active < this.concurrency &&
      this._queue.length > 0 &&
      !this._aborted
    ) {
      const task = this._queue.shift();
      this._active++;
      this._fetchWithRetry(task)
        .then((data) => {
          this._active--;
          task.resolve(data);
          this._processQueue();
        })
        .catch((err) => {
          this._active--;
          task.reject(err);
          this._processQueue();
        });
    }
  }

  async _fetchWithRetry(task) {
    const timeout = task.options.timeout || 30000;
    const headers = task.options.headers || {};

    while (true) {
      if (this._aborted) throw new Error("Pool aborted");

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const resp = await fetch(task.url, {
          headers,
          signal: controller.signal,
          cache: "no-cache",
        });
        clearTimeout(timer);

        if (!resp.ok) {

          if (resp.status >= 500 && task.retries < this.maxRetries) {
            task.retries++;
            const delay = 500 * Math.pow(2, task.retries - 1);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`Segment ${task.index}: HTTP ${resp.status}`);
        }

        const buffer = await resp.arrayBuffer();
        return new Uint8Array(buffer);
      } catch (err) {
        if (this._aborted) throw new Error("Pool aborted");

        if (
          task.retries < this.maxRetries &&
          !err.message.includes("aborted")
        ) {
          task.retries++;
          const delay = 500 * Math.pow(2, task.retries - 1);
          console.warn(
            `[SegmentPool] Segment ${task.index} retry ${task.retries}/${this.maxRetries}: ${err.message}`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  cancel() {
    this._aborted = true;

    for (const task of this._queue) {
      task.reject(new Error("Pool cancelled"));
    }
    this._queue = [];
  }

  reset() {
    this.cancel();
    this._aborted = false;
    this._active = 0;
  }
}
