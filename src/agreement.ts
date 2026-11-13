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
	/** The machine chosen for the line, and the dates it is rented for. */
	serial?: string | null;
	rentalStart?: Date | string | null;
	rentalEnd?: Date | string | null;
}

const isoOrUndefined = (value: Date | string | null | undefined): string | undefined => {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * The lines the platform renders an agreement from.
 *
 * The serial number and rental dates ride along when the line has them, so the
 * agreement the customer reads before signing shows the machine and the term
 * rather than blanks. They are left out entirely when absent.
 */
export const agreementLines = (lines: AgreementLineSource[]) =>
	lines.map((line) => ({
		productId: line.externalProductId,
		quantity: line.quantity,
		rentalTenure: line.rentalTenure ?? 1,
		unitPrice: Number(line.unitPrice),
		depositAmount: Number(line.depositAmount),
		...(line.serial ? { serial: line.serial } : {}),
		...(isoOrUndefined(line.rentalStart) ? { rentalStart: isoOrUndefined(line.rentalStart) } : {}),
		...(isoOrUndefined(line.rentalEnd) ? { rentalEnd: isoOrUndefined(line.rentalEnd) } : {}),
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
