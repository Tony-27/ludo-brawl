/** Tiny promise-based tween engine driven by the render loop (times in seconds). */

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outElastic: (t: number) =>
    t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
} satisfies Record<string, Ease>;

interface Task {
  start: number;
  duration: number;
  update: (t: number) => void;
  ease: Ease;
  resolve: () => void;
}

export class Animator {
  private tasks = new Set<Task>();
  private time = 0;

  get now() {
    return this.time;
  }

  get busy() {
    return this.tasks.size > 0;
  }

  update(dt: number) {
    this.time += dt;
    for (const task of [...this.tasks]) {
      const raw = task.duration <= 0 ? 1 : Math.min(1, (this.time - task.start) / task.duration);
      task.update(task.ease(raw));
      if (raw >= 1) {
        this.tasks.delete(task);
        task.resolve();
      }
    }
  }

  tween(duration: number, update: (t: number) => void, easing: Ease = ease.linear): Promise<void> {
    return new Promise((resolve) => {
      this.tasks.add({ start: this.time, duration, update, ease: easing, resolve });
    });
  }

  wait(duration: number): Promise<void> {
    return this.tween(duration, () => {});
  }

  /** Finish everything immediately (jumping to the end state). */
  flush() {
    for (const task of [...this.tasks]) {
      task.update(1);
      task.resolve();
    }
    this.tasks.clear();
  }
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
