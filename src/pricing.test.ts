import assert from "node:assert/strict";
import test from "node:test";
import { priceLines } from "./pricing.js";

test("prices the current rental period and deposit without charging the full tenure", () => {
	const result = priceLines([{ quantity: 1, unitPrice: 100, originalUnitPrice: 120, rentalTenure: 2, depositAmount: 50 }], 0.091);
	assert.deepEqual(result.totals, {
		subtotal: 100,
		discountTotal: 20,
		taxTotal: 9.1,
		feeTotal: 0,
		warrantyTotal: 0,
		shippingTotal: 0,
		depositTotal: 50,
		creditTotal: 0,
		grandTotal: 159.1,
	});
});

test("uses integer cents for split lines", () => {
	const result = priceLines([
		{ quantity: 3, unitPrice: 0.1 },
		{ quantity: 1, unitPrice: 0.2 },
	], 0);
	assert.equal(result.totals.grandTotal, 0.5);
});

test("a rental line bills recurring add-ons every period and one-off add-ons once", () => {
	// Rent 2000 + damage waiver 150 + filter plan 30 = 2180 per period;
	// installation 120 is a one-off fee; 1500 deposit is refundable.
	const result = priceLines(
		[{ quantity: 1, unitPrice: 2180, originalUnitPrice: 2580, feeAmount: 120, depositAmount: 1500, rentalTenure: 3 }],
		0.12,
	);
	assert.deepEqual(result.totals, {
		subtotal: 2180,
		discountTotal: 400,
		// Tax falls on the period charge and the one-off fee, never the deposit.
		taxTotal: 276,
		feeTotal: 120,
		warrantyTotal: 0,
		shippingTotal: 0,
		depositTotal: 1500,
		creditTotal: 0,
		grandTotal: 4076,
	});
	// Tenure does not multiply the charge: a rental collects the current period.
	assert.equal(result.lines[0]?.lineTotal, 4076);
});

test("removed optional recurring and one-time fees no longer affect tax or amount due", () => {
	// Base rent 2,000 plus a required recurring protection fee of 30. The
	// optional 150 recurring waiver and 120 one-time installation were removed.
	const result = priceLines(
		[{ quantity: 1, unitPrice: 2030, originalUnitPrice: 2430, feeAmount: 0, depositAmount: 1500, rentalTenure: 3 }],
		0.12,
	);
	assert.deepEqual(result.totals, {
		subtotal: 2030,
		discountTotal: 400,
		taxTotal: 243.6,
		feeTotal: 0,
		warrantyTotal: 0,
		shippingTotal: 0,
		depositTotal: 1500,
		creditTotal: 0,
		grandTotal: 3773.6,
	});
});

test("delivery shipping is included and taxed using the store rate", () => {
	const result = priceLines(
		[{ quantity: 1, unitPrice: 100, feeAmount: 20, depositAmount: 50 }],
		0.1,
		30,
	);
	assert.deepEqual(result.totals, {
		subtotal: 100,
		discountTotal: 0,
		taxTotal: 15,
		feeTotal: 20,
		warrantyTotal: 0,
		shippingTotal: 30,
		depositTotal: 50,
		creditTotal: 0,
		grandTotal: 215,
	});
});

test("pickup has no shipping charge", () => {
	const result = priceLines([{ quantity: 1, unitPrice: 100 }], 0.1, 0);
	assert.equal(result.totals.shippingTotal, 0);
	assert.equal(result.totals.taxTotal, 10);
	assert.equal(result.totals.grandTotal, 110);
});

test("a credit comes off the total after tax, and never more than the sale", () => {
	const owed = priceLines([{ quantity: 1, unitPrice: 100 }], 0.1, 0, 30);
	// Tax is still charged on the whole rental: the credit returns the
	// customer's own money rather than discounting what they are renting.
	assert.equal(owed.totals.taxTotal, 10);
	assert.equal(owed.totals.creditTotal, 30);
	assert.equal(owed.totals.grandTotal, 80);

	const covered = priceLines([{ quantity: 1, unitPrice: 100 }], 0.1, 0, 500);
	// A credit worth more than the sale covers it; the till gives no change.
	assert.equal(covered.totals.creditTotal, 110);
	assert.equal(covered.totals.grandTotal, 0);
});

test("a warranty is part of the sale and is taxed with the rental it covers", () => {
	const result = priceLines([{ quantity: 1, unitPrice: 100, warrantyAmount: 25, depositAmount: 50 }], 0.1);
	assert.equal(result.totals.subtotal, 100);
	assert.equal(result.totals.warrantyTotal, 25);
	// 10% of (100 + 25); the deposit is not taxed.
	assert.equal(result.totals.taxTotal, 12.5);
	assert.equal(result.totals.grandTotal, 187.5);
	assert.equal(result.lines[0]?.lineTotal, 187.5);
});

test("a sale without a warranty is priced exactly as before", () => {
	const result = priceLines([{ quantity: 1, unitPrice: 100, depositAmount: 50 }], 0.1);
	assert.equal(result.totals.warrantyTotal, 0);
	assert.equal(result.totals.grandTotal, 160);
});
