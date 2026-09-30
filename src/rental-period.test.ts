import assert from "node:assert/strict";
import test from "node:test";
import { monthsBetween } from "./cart-service.js";

test("counts calendar months, not 30-day blocks", () => {
	assert.equal(monthsBetween("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"), 1);
	// February is short; it is still one month of rent.
	assert.equal(monthsBetween("2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"), 1);
	assert.equal(monthsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"), 12);
});

test("does not round a part-month up into a billed month", () => {
	// 1 Jan to 31 Jan is not a month: the day of month has not come round yet.
	assert.equal(monthsBetween("2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"), 1);
	assert.equal(monthsBetween("2026-01-15T00:00:00.000Z", "2026-03-14T00:00:00.000Z"), 1);
	assert.equal(monthsBetween("2026-01-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"), 2);
});

test("never returns less than one billing period", () => {
	assert.equal(monthsBetween("2026-01-10T00:00:00.000Z", "2026-01-11T00:00:00.000Z"), 1);
});
