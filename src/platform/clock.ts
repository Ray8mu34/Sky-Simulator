/** A single monotonic clock; simulation time never accumulates per-frame rounding. */
export class SimulationClock {
  private anchorUt = 0;
  private anchorPerformanceMs = 0;
  private rate = 1;
  private running = false;
  private rebaseTotal = 0;
  get rebaseCount(): number { return this.rebaseTotal; }
  rebase(utDaysJ2000: number, rate: number, running: boolean, nowMs: number): void {
    if (![utDaysJ2000, rate, nowMs].every(Number.isFinite)) throw new RangeError('时钟参数须为有限数值');
    this.anchorUt = utDaysJ2000;
    this.anchorPerformanceMs = nowMs;
    this.rate = rate;
    this.running = running;
    this.rebaseTotal++;
  }
  sample(nowMs: number): number {
    return this.anchorUt + (this.running ? (nowMs - this.anchorPerformanceMs) * this.rate / 86_400_000 : 0);
  }
}
