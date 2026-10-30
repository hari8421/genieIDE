import type { Geneproperties as GenepropertiesType } from './types';

export class Geneproperties implements GenepropertiesType {
  readonly maxCoreLines: number;
  readonly contextBudgetTokens: number;

  constructor(opts?: { maxCoreLines?: number; contextBudgetTokens?: number }) {
    this.maxCoreLines = opts?.maxCoreLines ?? 200;
    this.contextBudgetTokens = opts?.contextBudgetTokens ?? 8192;
  }
}
