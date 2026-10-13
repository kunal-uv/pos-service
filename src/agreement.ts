/**
 * Pure helpers for the rental-agreement step, kept free of the database so
 * they can be tested without one.
 */

export interface AgreementLineSource {
	externalProductId: string;
	quantity: number;
	rentalTenure: number | null;
	unitPrice: unknown;
	depositAmount: unknown;
}

/** The lines the platform renders an agreement from. */
export const agreementLines = (lines: AgreementLineSource[]) =>
	lines.map((line) => ({
		productId: line.externalProductId,
		quantity: line.quantity,
		rentalTenure: line.rentalTenure ?? 1,
		unitPrice: Number(line.unitPrice),
		depositAmount: Number(line.depositAmount),
	}));

/**
 * The fulfilment with the agreement acceptance removed. The text of the
 * agreement depends on the customer and the lines, so an acceptance recorded
 * against different ones means nothing and the till has to ask again.
 */
export const withoutAgreementAcceptance = (value: unknown): unknown => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const { agreementAccepted: _dropped, ...rest } = value as Record<string, unknown>;
	return rest;
};
