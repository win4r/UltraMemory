import { parseSmartMetadata } from "./smart-metadata.js";

export class FeedbackLearner {
  constructor(
    private store: { getById(id: string): Promise<any>; patchMetadata(id: string, patch: any): Promise<any> },
    private alpha: number = 0.15,
  ) {}

  async recordPositive(memoryId: string): Promise<void> {
    await this.applyEMA(memoryId, 1.0);
  }

  async recordNegative(memoryId: string): Promise<void> {
    await this.applyEMA(memoryId, 0.0);
  }

  async recordExplicit(memoryId: string, helpful: boolean): Promise<void> {
    await this.applyEMA(memoryId, helpful ? 1.0 : 0.0);
  }

  async setDirect(memoryId: string, weight: number): Promise<void> {
    const entry = await this.store.getById(memoryId);
    if (!entry) return;
    await this.store.patchMetadata(memoryId, { feedback_weight: Math.max(0, Math.min(1, weight)) });
  }

  private async applyEMA(memoryId: string, signal: number): Promise<void> {
    const entry = await this.store.getById(memoryId);
    if (!entry) return;
    const meta = parseSmartMetadata(entry.metadata, entry);
    const oldWeight = meta.feedback_weight ?? 0.5;
    const newWeight = this.alpha * signal + (1 - this.alpha) * oldWeight;
    await this.store.patchMetadata(memoryId, {
      feedback_weight: Math.max(0, Math.min(1, newWeight)),
    });
  }
}
