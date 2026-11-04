import { describe, expect, it } from "vitest";
import { energyTax, missingParts, totalPrice } from "../src/costs";

describe("total price", () => {
  it("adds energy tax and VAT to the spot price", () => {
    // 80 öre spot -> 100 incl. VAT; 36.0 öre tax -> 45 incl. VAT
    expect(totalPrice(0.8, 2026)).toMatchObject({ spot: 100, energy_tax: 45, total: 145 });
    expect(totalPrice(0.8, 2026).grid_fee).toBeUndefined();
  });

  it("adds the user's fees, given with or without VAT", () => {
    const incl = totalPrice(0.8, 2026, { grid_fee_ore: 25, supplier_markup_ore: 6 });
    expect(incl).toMatchObject({ grid_fee: 25, supplier_markup: 6, total: 176 });
    const excl = totalPrice(0.8, 2026, { grid_fee_ore: 20, supplier_markup_ore: 4.8, fees_include_vat: false });
    expect(excl.total).toBe(176);
  });

  it("handles spot-indexed grid tariffs like Landskrona's (13.36 öre + 6.19 % of spot, excl. VAT)", () => {
    const b = totalPrice(0.5, 2026, { grid_fee_ore: 13.36, grid_fee_percent_of_spot: 6.19, fees_include_vat: false });
    expect(b.grid_fee).toBeCloseTo(16.455 * 1.25, 1);
  });

  it("applies the northern reduction and knows the tax by year", () => {
    expect(totalPrice(0, 2026, { northern_tax_reduction: true }).energy_tax).toBe(33);
    expect(energyTax(2025)).toEqual({ ore: 43.9, assumed: false });
    expect(energyTax(2027)).toEqual({ ore: 36.0, assumed: true });
    expect(totalPrice(-0.1, 2026).total).toBe(32.5); // negative spot still pays tax
  });

  it("says what is missing", () => {
    expect(missingParts({})).toHaveLength(2);
    expect(missingParts({ grid_fee_percent_of_spot: 5, supplier_markup_ore: 3 })).toHaveLength(0);
  });
});
