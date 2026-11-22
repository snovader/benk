import { bench } from "benk";
// test/fixtures/v8/bundled/sum.ts
/** The sum of the values, which Turbofan inlines into a timer loop */
function sum(values) {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}
/** The mean of the values, which calls `sum` */
function mean(values) {
	return sum(values) / values.length;
}
// test/fixtures/v8/bundled/bench.ts
const SIZE = 1e3;
const integers = Array.from({ length: SIZE }, (_, i) => i);
const doubles = Array.from({ length: SIZE }, (_, i) => i + .5);
let calls = 0;
await bench([{
	name: "bundled",
	variants: [
		{
			name: "sum",
			run: () => sum(integers)
		},
		{
			name: "mean",
			run: () => mean(integers)
		},
		{
			name: "switching",
			run: () => sum(++calls < 2e4 ? integers : doubles)
		}
	]
}]);
export {};

//# sourceMappingURL=bench.mjs.map