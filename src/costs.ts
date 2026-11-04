// From spot price to what a household actually pays per kWh.
// Total = spot + supplier markup + energy tax + grid transfer fee, all plus 25 % VAT.
// Fixed monthly fees and power-based fees (effektavgift) don't depend on kWh and aren't included.

export const VAT_RATE = 0.25;

/** Energy tax on electricity, öre/kWh excl. VAT, by year (Skatteverket). */
const ENERGY_TAX: Record<number, number> = {
  2022: 36.0,
  2023: 39.2,
  2024: 42.8,
  2025: 43.9,
  2026: 36.0,
};
const LATEST_TAX_YEAR = Math.max(...Object.keys(ENERGY_TAX).map(Number));
/** Reduction for households in certain northern municipalities, öre/kWh excl. VAT. */
export const NORTHERN_REDUCTION = 9.6;

export interface CostSettings {
  /** Grid transfer fee (överföringsavgift), öre/kWh. */
  grid_fee_ore?: number;
  /** For spot-indexed grid tariffs: extra percent of the spot price, e.g. 6.19. */
  grid_fee_percent_of_spot?: number;
  /** Supplier markup incl. certificates (påslag + elcertifikat), öre/kWh. */
  supplier_markup_ore?: number;
  /** Whether the fees above are given including VAT, as consumer price lists usually are. Default true. */
  fees_include_vat?: boolean;
  /** Household in a municipality with reduced energy tax (parts of northern Sweden). */
  northern_tax_reduction?: boolean;
}

export function energyTax(year: number, northern = false): { ore: number; assumed: boolean } {
  const known = ENERGY_TAX[year];
  const base = known ?? ENERGY_TAX[year > LATEST_TAX_YEAR ? LATEST_TAX_YEAR : Math.min(...Object.keys(ENERGY_TAX).map(Number))]!;
  return { ore: Math.max(0, base - (northern ? NORTHERN_REDUCTION : 0)), assumed: known === undefined };
}

export function hasCostSettings(s: CostSettings | undefined): s is CostSettings {
  return !!s && (s.grid_fee_ore !== undefined || s.grid_fee_percent_of_spot !== undefined || s.supplier_markup_ore !== undefined || s.northern_tax_reduction !== undefined);
}

export interface TotalBreakdown {
  total: number; // öre/kWh incl. VAT
  spot: number;
  energy_tax: number;
  grid_fee?: number;
  supplier_markup?: number;
  vat_included: true;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Total price per kWh incl. VAT for a spot price in SEK/kWh excl. VAT.
 * Each part is reported incl. VAT so the parts add up to the total.
 */
export function totalPrice(spotSek: number, year: number, s: CostSettings = {}): TotalBreakdown {
  const vat = 1 + VAT_RATE;
  const feeFactor = s.fees_include_vat === false ? vat : 1; // turn ex-VAT fees into incl. VAT
  const spot = spotSek * 100 * vat;
  const tax = energyTax(year, s.northern_tax_reduction).ore * vat;
  let grid: number | undefined;
  if (s.grid_fee_ore !== undefined || s.grid_fee_percent_of_spot !== undefined) {
    // Spot-indexed tariffs: X % of the spot price (excl. VAT). Like the other fees, the percentage is
    // taken as including VAT unless fees_include_vat is false.
    const indexed = ((s.grid_fee_percent_of_spot ?? 0) / 100) * spotSek * 100 * feeFactor;
    grid = (s.grid_fee_ore ?? 0) * feeFactor + indexed;
  }
  const markup = s.supplier_markup_ore !== undefined ? s.supplier_markup_ore * feeFactor : undefined;
  const total = spot + tax + (grid ?? 0) + (markup ?? 0);
  return {
    total: r1(total),
    spot: r1(spot),
    energy_tax: r1(tax),
    grid_fee: grid === undefined ? undefined : r1(grid),
    supplier_markup: markup === undefined ? undefined : r1(markup),
    vat_included: true,
  };
}

/** Which parts the caller left out, so answers can say what the total doesn't include. */
export function missingParts(s: CostSettings | undefined): string[] {
  const missing: string[] = [];
  if (s?.grid_fee_ore === undefined && s?.grid_fee_percent_of_spot === undefined) missing.push("grid transfer fee (överföringsavgift)");
  if (s?.supplier_markup_ore === undefined) missing.push("supplier markup (påslag)");
  return missing;
}
