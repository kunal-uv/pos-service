export interface PriceableLine {
	quantity: number;
	unitPrice: number;
	originalUnitPrice?: number | null;
	feeAmount?: number;
	depositAmount?: number;
	rentalTenure?: number | null;
}

export interface PricedLine extends PriceableLine {
	discountAmount: number;
	taxAmount: number;
	lineTotal: number;
}

const cents = (value: number) => Math.round((Number.isFinite(value) ? value : 0) * 100);
const dollars = (value: number) => value / 100;

/**
 * `creditAmount` is money the shop already holds for this customer - the value
 * of a machine handed back over the counter - and it comes off the total after
 * tax. Tax is charged on what is being rented, in full: the credit returns the
 * customer's own money rather than discounting the new rental, and a credit
 * larger than the sale simply covers it (the till never pays out change).
 */
/**
 * The charges the operator added at the counter, each with its own
 * taxability — whether a stair carry or an after-hours call-out is taxable is
 * a judgement about the job, not a property of the store.
 */
export interface OperatorCharges {
	/** Delivery for this job. Zero on a pickup. */
	shippingAmount?: number;
	shippingTaxable?: boolean;
	/** One labelled charge for anything that is not delivery. */
	customAmount?: number;
	customTaxable?: boolean;
}

export const priceLines = (
	lines: PriceableLine[],
	taxRate: number,
	shippingAmount: number | OperatorCharges = 0,
	creditAmount = 0,
) => {
	/**
	 * Accepts a bare shipping amount as well as the full charge set: the other
	 * tenant's till still calls this with a number, and an untaxed delivery was
	 * not a thing it could express.
	 */
	const charges: OperatorCharges = typeof shippingAmount === "number"
		? {shippingAmount, shippingTaxable: true}
		: shippingAmount;

	const safeRate = Math.max(0, taxRate);
	const shipping = Math.max(0, cents(charges.shippingAmount ?? 0));
	const shippingTax = charges.shippingTaxable === false
		? 0 : Math.round(shipping * safeRate);
	const custom = Math.max(0, cents(charges.customAmount ?? 0));
	const customTax = charges.customTaxable === false
		? 0 : Math.round(custom * safeRate);
	const priced: PricedLine[] = lines.map((line) => {
		const quantity = Math.max(1, Math.trunc(line.quantity));
		// A rental checkout collects the current billing period plus its deposit.
		// Tenure describes the contract length; multiplying by it here would charge
		// the full agreement even though the platform order remains recurring.
		const current = cents(line.unitPrice) * quantity;
		const original = cents(line.originalUnitPrice ?? line.unitPrice) * quantity;
		const discount = Math.max(0, original - current);
		const fees = Math.max(0, cents(line.feeAmount ?? 0));
		const deposit = Math.max(0, cents(line.depositAmount ?? 0));
		const tax = Math.round((current + fees) * safeRate);
		return {
			...line,
			quantity,
			discountAmount: dollars(discount),
			taxAmount: dollars(tax),
			lineTotal: dollars(current + fees + deposit + tax),
		};
	});

	const sum = (pick: (line: PricedLine) => number) => dollars(priced.reduce((total, line) => total + cents(pick(line)), 0));
	const gross = cents(sum((line) => line.lineTotal))
		+ shipping + shippingTax + custom + customTax;
	const creditApplied = Math.min(Math.max(0, cents(creditAmount)), gross);
	return {
		lines: priced,
		totals: {
			subtotal: sum((line) => line.unitPrice * line.quantity),
			discountTotal: sum((line) => line.discountAmount),
			taxTotal: dollars(cents(sum((line) => line.taxAmount)) + shippingTax + customTax),
			feeTotal: sum((line) => line.feeAmount ?? 0),
			shippingTotal: dollars(shipping),
			customTotal: dollars(custom),
			depositTotal: sum((line) => line.depositAmount ?? 0),
			/** What the credit actually paid for, never more than the sale. */
			creditTotal: dollars(creditApplied),
			grandTotal: dollars(gross - creditApplied),
		},
	};
};
