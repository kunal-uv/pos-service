import assert from "node:assert/strict";
import test from "node:test";
import { agreementLines, withoutAgreementAcceptance } from "./agreement.js";

test("maps cart lines to the agreement request", () => {
	assert.deepEqual(
		agreementLines([{ externalProductId: "p1", quantity: 2, rentalTenure: 6, unitPrice: "100.50", depositAmount: 20 }]),
		[{ productId: "p1", quantity: 2, rentalTenure: 6, unitPrice: 100.5, depositAmount: 20 }],
	);
});

test("drops only the agreement acceptance from a fulfilment", () => {
	assert.deepEqual(
		withoutAgreementAcceptance({ method: "pickup", agreementAccepted: true, signatureData: "x" }),
		{ method: "pickup", signatureData: "x" },
	);
	assert.equal(withoutAgreementAcceptance(null), null);
});
