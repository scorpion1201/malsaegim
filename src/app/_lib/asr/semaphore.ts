export class SemaphoreTimeoutError extends Error {
  constructor() {
    super('semaphore wait timed out');
    this.name = 'SemaphoreTimeoutError';
     }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
      }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new SemaphoreTimeoutError());
           }, timeoutMs),
        };
      this.waiters.push(waiter);
      });
    }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.makeRelease());
       } else {
        this.active -= 1;
       }
      };
    }
}