import assert from "node:assert/strict";
import test from "node:test";
import { agreementLines, withoutAgreementAcceptance } from "./agreement.js";

test("maps cart lines to the agreement request", () => {
	assert.deepEqual(
		agreementLines([{ externalProductId: "p1", quantity: 2, rentalTenure: 6, unitPrice: "100.50", depositAmount: 20 }]),
		[{ productId: "p1", quantity: 2, rentalTenure: 6, unitPrice: 100.5, depositAmount: 20 }],
	);
});

test("carries the serial number and rental dates when the line has them", () => {
	assert.deepEqual(
		agreementLines([{
			externalProductId: "p1", quantity: 1, rentalTenure: 1, unitPrice: 10, depositAmount: 0,
			serial: "SN-001", rentalStart: "2026-11-09T00:00:00.000Z", rentalEnd: new Date("2026-12-09T00:00:00.000Z"),
		}]),
		[{
			productId: "p1", quantity: 1, rentalTenure: 1, unitPrice: 10, depositAmount: 0,
			serial: "SN-001", rentalStart: "2026-11-09T00:00:00.000Z", rentalEnd: "2026-12-09T00:00:00.000Z",
		}],
	);
});

test("leaves out an unreadable date instead of sending garbage", () => {
	const [line] = agreementLines([{
		externalProductId: "p1", quantity: 1, rentalTenure: 1, unitPrice: 10, depositAmount: 0, rentalStart: "not a date",
	}]);
	assert.ok(line);
	assert.equal("rentalStart" in line, false);
});

test("drops only the agreement acceptance from a fulfilment", () => {
	assert.deepEqual(
		withoutAgreementAcceptance({ method: "pickup", agreementAccepted: true, signatureData: "x" }),
		{ method: "pickup", signatureData: "x" },
	);
	assert.equal(withoutAgreementAcceptance(null), null);
});
