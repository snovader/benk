// source/core/arguments.ts
function readArguments(args, spec) {
	const values = new Map();
	const flags = new Map();
	for (const token of tokenize(args, spec)) if (spec.values.has(token.name)) values.set(token.name, checkedValue(token));
	else {
		const flag = namedFlag(token, spec);
		if (token.value != null) throw new TypeError(`Expected --${flag.name} without a value, got ${token.raw}`);
		flags.set(flag.name, flag.set);
	}
	return {
		values,
		flags
	};
}
function* tokenize(args, spec) {
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === "--" && at === args.length - 1) return;
		if (arg === "--" || !arg.startsWith("--")) {
			const wrong = arg === "--" ? `${args[at + 1]} after --` : arg;
			throw new TypeError(`Expected an option, one of ${optionNames(spec)}, got ${wrong}`);
		}
		const equals = arg.indexOf("=");
		const name = arg.slice(2, equals === -1 ? void 0 : equals);
		if (equals !== -1) yield {
			name,
			raw: arg,
			value: arg.slice(equals + 1),
			inline: true
		};
		else if (spec.values.has(name) && at + 1 < args.length) {
			at++;
			yield {
				name,
				raw: arg,
				value: args[at],
				inline: false
			};
		} else yield {
			name,
			raw: arg,
			value: void 0,
			inline: false
		};
	}
}
function checkedValue({ name, value, inline }) {
	if (value == null) throw new TypeError(`Expected a value after --${name}, got none`);
	if (!inline && value.length > 1 && value.startsWith("-")) throw new TypeError(`Expected a value after --${name}, got ${value}, which looks like an option: write --${name}=${value} for such a value`);
	return value;
}
function namedFlag({ name, raw }, spec) {
	if (spec.flags.has(name)) return {
		name,
		set: true
	};
	const negated = name.startsWith("no-") ? name.slice(3) : void 0;
	if (negated == null || !spec.flags.has(negated)) throw new TypeError(`Expected an option, one of ${optionNames(spec)}, got ${raw}`);
	return {
		name: negated,
		set: false
	};
}
function optionNames({ values, flags }) {
	return [...Array.from(values, (name) => `--${name}`), ...Array.from(flags, (name) => `--[no-]${name}`)].join(", ");
}
// source/core/statistics.ts
const MODE_SHARE = .1;
const MODE_ROUNDS = 3;
const MODE_SEPARATION = 4;
function summarize(samples) {
	if (samples.length === 0) throw new RangeError("Expected at least one sample");
	const sorted = sortedCopy(samples);
	const q1 = quantile(sorted, .25);
	const median = quantile(sorted, .5);
	const q3 = quantile(sorted, .75);
	return {
		fastest: quantile(sorted, 0),
		q1,
		median,
		q3,
		slowest: quantile(sorted, 1),
		spread: q3 === q1 ? 0 : (q3 - q1) / median,
		modes: modesOf(sorted)
	};
}
function sortedCopy(numbers) {
	const sorted = Float64Array.from(numbers);
	sorted.sort();
	return sorted;
}
function quantile(sorted, p) {
	return sorted[Math.ceil(p * (sorted.length - 1))];
}
function modesOf(sorted) {
	const count = sorted.length;
	const least = Math.max(MODE_ROUNDS, Math.ceil(count * MODE_SHARE));
	if (count < 2 * least || !(sorted[0] > 0)) return null;
	const first = bestSplit(sorted.map(Math.log), least);
	const middle = Math.sqrt(quantile(sorted.subarray(0, first), .5) * quantile(sorted.subarray(first), .5));
	const split = sorted.findIndex((sample) => sample >= middle);
	if (split < least || count - split < least) return null;
	const fast = sorted.subarray(0, split);
	const slow = sorted.subarray(split);
	const fastMedian = quantile(fast, .5);
	const slowMedian = quantile(slow, .5);
	const width = (logRange(fast) + logRange(slow)) / 2;
	if (slowMedian < fastMedian * 1.05 || Math.log(slowMedian / fastMedian) < MODE_SEPARATION * width) return null;
	return {
		fast: {
			median: fastMedian,
			rounds: fast.length
		},
		slow: {
			median: slowMedian,
			rounds: slow.length
		}
	};
}
function bestSplit(sorted, least) {
	const count = sorted.length;
	const total = sorted.reduce((sum, value) => sum + value, 0);
	let best = least;
	let bestScore = -1;
	let prefix = 0;
	for (let split = 1; split <= count - least; split++) {
		prefix += sorted[split - 1];
		if (split >= least) {
			const difference = (total - prefix) / (count - split) - prefix / split;
			const score = split * (count - split) * difference * difference;
			if (score > bestScore) {
				best = split;
				bestScore = score;
			}
		}
	}
	return best;
}
function logRange(sorted) {
	return Math.log(quantile(sorted, .75) / quantile(sorted, .25));
}
function medianInterval(sorted, confidence = .95) {
	const count = sorted.length;
	const tail = (1 - confidence) / 2;
	let k = 0;
	let cumulative = 0;
	let logProbability = -count * Math.LN2;
	while (k < count) {
		const next = cumulative + Math.exp(logProbability);
		if (next > tail) break;
		cumulative = next;
		logProbability += Math.log((count - k) / (k + 1));
		k++;
	}
	return k === 0 ? null : [sorted[k - 1], sorted[count - k]];
}
function pairedRatios(samples, reference) {
	const ratios = new Float64Array(samples.length);
	for (let i = 0; i < ratios.length; i++) ratios[i] = samples[i] / reference[i];
	return ratios;
}
// source/core/array-buffers.ts
const SAMPLES$1 = 5;
const ATTEMPTS = 40;
async function arrayBufferBytesPerCall(meter, variant) {
	const perCall = new Float64Array(SAMPLES$1);
	let counted = 0;
	let repetitions = variant.repetitions();
	for (let attempt = 0; attempt < ATTEMPTS && counted < SAMPLES$1; attempt++) {
		await meter.settle();
		const bytes = await variant.allocated(meter, repetitions);
		if (bytes == null) repetitions = Math.ceil(repetitions / 2);
		else perCall[counted++] = bytes / repetitions;
	}
	if (counted < SAMPLES$1) return null;
	perCall.sort();
	return quantile(perCall, .5);
}
// source/core/clock.ts
const GIVE_UP_CALLS = 2 ** 26;
const PASSES = 2;
const HALF_LOOPS = 8;
function empty() {}
const resolutions = new WeakMap();
function timerResolutionOf(runtime) {
	let resolution = resolutions.get(runtime);
	if (resolution === void 0) {
		resolution = estimateResolution(runtime.createTimer());
		resolutions.set(runtime, resolution);
	}
	return resolution;
}
function estimateResolution(timer) {
	let shortest = 1e400;
	for (let pass = 0; pass < PASSES; pass++) {
		const first = firstReading(timer);
		if (first == null) return null;
		const half = Math.max(1, first.calls / 2);
		shortest = Math.min(shortest, first.elapsed, shortestReading(timer, half));
	}
	return shortest * 1e6;
}
function firstReading(timer) {
	for (let calls = 1; calls <= GIVE_UP_CALLS; calls *= 2) {
		const elapsed = timer(empty, calls);
		if (elapsed > 0) return {
			calls,
			elapsed
		};
	}
}
function shortestReading(timer, calls) {
	let shortest = 1e400;
	for (let loop = 0; loop < HALF_LOOPS; loop++) {
		const elapsed = timer(empty, calls);
		if (elapsed > 0 && elapsed < shortest) shortest = elapsed;
	}
	return shortest;
}
// source/core/timed-variant.ts
const CALIBRATION_CALLS = 1 << 20;
const LEAST_TIME = .001;
var TimedVariant = class {
	#loop;
	#placement;
	#repetitions = 1;
	constructor(variant, placement, runtime) {
		this.#loop = variant.async ? {
			async: true,
			variant,
			timer: runtime.createAsyncTimer()
		} : {
			async: false,
			variant,
			timer: runtime.createTimer()
		};
		this.#placement = placement;
	}
	name() {
		return this.#placement.name;
	}
	role() {
		return this.#placement.role;
	}
	isAsync() {
		return this.#loop.async;
	}
	repetitions() {
		return this.#repetitions;
	}
	time() {
		const repetitions = this.#repetitions;
		const elapsed = this.#run(repetitions);
		return typeof elapsed === "number" ? perCall(elapsed, repetitions) : elapsed.then((time) => perCall(time, repetitions));
	}
	allocated(meter, repetitions) {
		return this.#run(repetitions, meter);
	}
	async calibrate(sampleTime, clockReads) {
		this.#checkResult();
		if (await this.#double(sampleTime) === 0 && !clockReads) throw new Error(`Expected the runtime's clock to advance, but it read no time for empty calls, nor for ${CALIBRATION_CALLS.toLocaleString("en-US")} calls of ${this.#label()}`);
	}
	async recalibrate(fastest, sampleTime) {
		if (fastest > 0) this.#fit(fastest, sampleTime);
		else await this.#double(sampleTime);
	}
	async #double(sampleTime) {
		for (let repetitions = 1;; repetitions *= 2) {
			const elapsed = await this.#run(repetitions);
			if (elapsed >= sampleTime / 4 || repetitions >= CALIBRATION_CALLS) {
				this.#fit(perCall(elapsed, repetitions), sampleTime);
				return elapsed;
			}
		}
	}
	#fit(nanoseconds, sampleTime) {
		this.#repetitions = Math.max(1, Math.round(sampleTime * 1e6 / Math.max(nanoseconds, LEAST_TIME)));
	}
	#run(repetitions, meter) {
		const loop = this.#loop;
		if (loop.async) return this.#runAsync(loop, repetitions, meter).catch((error) => this.#fail(error));
		try {
			loop.variant.setup?.(repetitions);
			const stop = meter?.start();
			const elapsed = loop.timer(loop.variant.run, repetitions);
			const result = stop === void 0 ? elapsed : stop();
			loop.variant.teardown?.();
			return result;
		} catch (error) {
			return this.#fail(error);
		}
	}
	async #runAsync({ variant, timer }, repetitions, meter) {
		await variant.setup?.(repetitions);
		const stop = meter?.start();
		const elapsed = await timer(variant.run, repetitions);
		const result = stop === void 0 ? elapsed : stop();
		await variant.teardown?.();
		return result;
	}
	#checkResult() {
		const loop = this.#loop;
		if (loop.async) return;
		let result;
		try {
			const { run } = loop.variant;
			loop.variant.setup?.(1);
			result = run();
			loop.variant.teardown?.();
		} catch (error) {
			this.#fail(error);
		}
		if (isThenable(result)) {
			Promise.resolve(result).catch(() => void 0);
			throw new TypeError(`${this.#label()} returned a promise, which a sync variant's loop wouldn't await. Mark the variant \`async: true\`.`);
		}
	}
	#fail(error) {
		throw new Error(`${this.#label()} threw`, { cause: error });
	}
	#label() {
		const { group, name } = this.#placement;
		return `Variant "${name}" of group "${group}"`;
	}
};
function perCall(milliseconds, repetitions) {
	return milliseconds * 1e6 / repetitions;
}
function isThenable(value) {
	return (typeof value === "object" || typeof value === "function") && value !== null && "then" in value && typeof value.then === "function";
}
// source/core/heap.ts
const SAMPLES = 5;
const BASELINE_SAMPLES = 20;
var HeapCounter = class {
	#meter;
	#runtime;
	#syncBaseline;
	#asyncBaseline;
	constructor(meter, runtime) {
		this.#meter = meter;
		this.#runtime = runtime;
	}
	async bytesPerCall(variant) {
		const repetitions = variant.repetitions();
		const baseline = await this.#baseline(variant.isAsync());
		const samples = await this.#samples(variant, repetitions);
		samples.sort();
		return (quantile(samples, .5) - baseline) / repetitions;
	}
	#baseline(async) {
		if (async) {
			this.#asyncBaseline ??= this.#measureBaseline(new TimedVariant({
				name: "empty",
				async: true,
				run: () => Promise.resolve()
			}, {
				name: "empty",
				role: "variant",
				group: "baseline"
			}, this.#runtime));
			return this.#asyncBaseline;
		}
		this.#syncBaseline ??= this.#measureBaseline(new TimedVariant({
			name: "empty",
			run: () => void 0
		}, {
			name: "empty",
			role: "variant",
			group: "baseline"
		}, this.#runtime));
		return this.#syncBaseline;
	}
	async #measureBaseline(empty) {
		const samples = await this.#samples(empty, 0, BASELINE_SAMPLES);
		samples.sort();
		return quantile(samples, .5);
	}
	async #samples(variant, repetitions, count = SAMPLES) {
		const bytes = new Float64Array(count);
		for (let sample = 0; sample < count; sample++) bytes[sample] = await variant.allocated(this.#meter, repetitions);
		return bytes;
	}
};
const counters = new WeakMap();
function heapCounterOf(runtime) {
	const { heap } = runtime;
	if (heap == null) return;
	let counter = counters.get(runtime);
	if (counter == null) {
		counter = new HeapCounter(heap, runtime);
		counters.set(runtime, counter);
	}
	return counter;
}
// source/core/lead.ts
const LONG_CALL = 1e3;
const ALLOCATING_CALL = 1024;
function chooseLead(set, variants) {
	if (set !== "auto") return {
		lead: set,
		reason: "set"
	};
	if (variants.some(({ summary }) => summary.median >= 1e3)) return {
		lead: "median",
		reason: "long calls"
	};
	if (variants.some(allocates)) return {
		lead: "median",
		reason: "allocating calls"
	};
	return {
		lead: "fastest",
		reason: "short calls"
	};
}
function allocates({ heapBytes, arrayBufferBytes }) {
	return (heapBytes ?? 0) + (arrayBufferBytes ?? 0) >= ALLOCATING_CALL;
}
// source/core/rotation.ts
function rotation(count) {
	if (!Number.isInteger(count) || count < 1) throw new RangeError(`Expected a positive integer count of variants, got ${count}`);
	if (count === 1) return [[0]];
	const first = firstOrder(count);
	const orders = first.map((_, shift) => first.map((variant) => (variant + shift) % count));
	return count % 2 === 0 ? orders : [...orders, ...orders.map((order) => order.toReversed())];
}
function firstOrder(count) {
	const order = [0];
	for (let position = 1; position < count; position++) {
		const step = Math.ceil(position / 2);
		order.push(position % 2 === 1 ? step : count - step);
	}
	return order;
}
// source/core/measure.ts
const DEFAULT_OPTIONS = {
	rounds: 31,
	warmupRounds: 10,
	sampleTime: 1,
	aa: true,
	heap: true
};
async function measureGroups(groups, options, runtime) {
	const resolved = resolveOptions(options);
	const date = new Date().toISOString();
	const filter = new RegExp(options.filter?.source ?? "", options.filter?.flags.replaceAll(/[gy]/g, ""));
	const results = [];
	for (const group of groups) if (filter.test(group.name)) {
		const result = await measureGroup(group, resolved, runtime);
		options.onGroup?.(result);
		results.push(result);
	}
	return {
		schema: 3,
		date,
		runtime: runtime.description,
		options: {
			...resolved,
			filter: options.filter?.source ?? ""
		},
		groups: results
	};
}
async function measureGroup(group, measureOptions, runtime) {
	const options = resolveOptions(measureOptions);
	const { sampleTime, warmupRounds } = options;
	const timerResolution = timerResolutionOf(runtime);
	const variants = timedVariants(group, options.aa, runtime);
	const orders = rotation(variants.length);
	const rounds = Math.ceil(options.rounds / orders.length) * orders.length;
	for (const variant of variants) await variant.calibrate(sampleTime, timerResolution !== null);
	if (warmupRounds > 0) {
		const warm = await timeRounds(variants, orders, warmupRounds);
		for (const [i, variant] of variants.entries()) await variant.recalibrate(Math.min(...warm.samples[i]), sampleTime);
	}
	const { samples, positions } = await timeRounds(variants, orders, rounds);
	const heap = options.heap ? heapCounterOf(runtime) : void 0;
	const arrayBuffers = options.heap ? runtime.arrayBuffers : void 0;
	const measured = [];
	for (const [i, variant] of variants.entries()) measured.push({
		variant,
		samples: samples[i],
		positions: positions[i],
		summary: summarize(samples[i]),
		heapBytes: await heap?.bytesPerCall(variant) ?? null,
		arrayBufferBytes: arrayBuffers ? await arrayBufferBytesPerCall(arrayBuffers, variant) : null
	});
	const { lead, reason } = chooseLead(group.lead ?? "auto", measured);
	return {
		name: group.name,
		lead,
		leadReason: reason,
		rounds,
		timerResolution,
		variants: measured.map((variant) => variantResult(variant, measured[0], lead))
	};
}
function timedVariants(group, aa, runtime) {
	const [reference] = group.variants;
	if (reference == null) throw new TypeError(`Expected group "${group.name}" to have variants`);
	const placed = group.variants.map((variant, i) => [
		variant,
		variant.name,
		i === 0 ? "reference" : "variant"
	]);
	if (group.aa ?? aa) placed.push([
		reference,
		`${reference.name} A/A`,
		"aa"
	]);
	const names = new Set();
	return placed.map(([variant, name, role]) => {
		if (names.has(name)) throw new TypeError(`Expected the variants of group "${group.name}" to have different names, but "${name}" repeats`);
		names.add(name);
		return new TimedVariant(variant, {
			name,
			role,
			group: group.name
		}, runtime);
	});
}
async function timeRounds(variants, orders, rounds) {
	const samples = variants.map(() => new Float64Array(rounds));
	const positions = variants.map(() => new Int32Array(rounds));
	for (let round = 0; round < rounds; round++) {
		const order = orders[round % orders.length];
		for (const [position, i] of order.entries()) {
			const time = variants[i].time();
			samples[i][round] = typeof time === "number" ? time : await time;
			positions[i][round] = position;
		}
	}
	return {
		samples,
		positions
	};
}
function variantResult({ variant, samples, positions, summary, heapBytes, arrayBufferBytes }, reference, lead) {
	const role = variant.role();
	const ratios = pairedRatios(samples, reference.samples);
	ratios.sort();
	const ratio = lead === "fastest" ? summary.fastest / reference.summary.fastest : quantile(ratios, .5);
	return {
		name: variant.name(),
		role,
		async: variant.isAsync(),
		repetitions: variant.repetitions(),
		samples: Array.from(samples),
		positions: Array.from(positions),
		summary,
		ratio: role === "reference" ? 1 : ratio,
		interval: role === "reference" ? null : medianInterval(ratios),
		heapBytes,
		arrayBufferBytes
	};
}
function resolveOptions(options) {
	const resolved = {
		rounds: options.rounds ?? DEFAULT_OPTIONS.rounds,
		warmupRounds: options.warmupRounds ?? DEFAULT_OPTIONS.warmupRounds,
		sampleTime: options.sampleTime ?? DEFAULT_OPTIONS.sampleTime,
		aa: options.aa ?? DEFAULT_OPTIONS.aa,
		heap: options.heap ?? DEFAULT_OPTIONS.heap
	};
	if (!Number.isInteger(resolved.rounds) || resolved.rounds < 1) throw new RangeError(`Expected rounds to be a positive integer, got ${resolved.rounds}`);
	if (!Number.isInteger(resolved.warmupRounds) || resolved.warmupRounds < 0) throw new RangeError(`Expected warm-up rounds to be an integer of at least 0, got ${resolved.warmupRounds}`);
	if (!(resolved.sampleTime > 0 && resolved.sampleTime < 1e400)) throw new RangeError(`Expected the sample time to be a positive number of milliseconds, got ${resolved.sampleTime}`);
	return resolved;
}
// source/core/report.ts
const COLUMNS = [
	["fastest", 11],
	["median", 11],
	["spread", 9],
	["ratio", 9],
	["95% interval", 15],
	["heap", 12],
	["buffers", 12]
];
const NAME_WIDTH = 16;
const ROUND_TICKS = 50;
const LONG = `${LONG_CALL / 1e3} µs`;
const ALLOCATING = `${ALLOCATING_CALL / 1024} KiB`;
const LEAD_REASONS = {
	set: "as the group sets",
	"short calls": `every call under ${LONG} and ${ALLOCATING}`,
	"long calls": `a call of ${LONG} or more`,
	"allocating calls": `a call allocating ${ALLOCATING} or more`
};
function describeRun(runtime, { rounds, warmupRounds, sampleTime, heap }) {
	const flags = runtime.flags.length > 0 ? `, with ${runtime.flags.join(" ")}` : "";
	const state = runtime.processState.length > 0 ? ` Process state: ${runtime.processState.join(", ")}.` : "";
	return [
		`${runtime.name} ${runtime.version}, ${runtime.engine}, ${runtime.platform} ${runtime.arch}, ${runtime.cpu}${flags}.${state}`,
		`Per call, of at least ${rounds} interleaved rounds of ${sampleTime} ms per variant after ${warmupRounds} warm-up rounds, in an order that rotates each variant through each position:`,
		"the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios" + (heap ? ", and the bytes allocated on the heap and in array buffers outside it." : ".")
	].join("\n");
}
function formatGroup({ name, lead, leadReason, rounds, timerResolution, variants }) {
	const nameWidth = Math.max(NAME_WIDTH, ...variants.map((variant) => variant.name.length));
	const header = `  ${"".padEnd(nameWidth)}${COLUMNS.map(([title, width]) => title.padStart(width)).join("")}`;
	return [
		"",
		`${name}: ${rounds} rounds, by the ${lead === "fastest" ? "fastest" : "median"} round (${LEAD_REASONS[leadReason]})`,
		header,
		...variants.map((variant) => formatRow(variant, nameWidth)),
		...formatResolution(timerResolution, variants),
		...variants.flatMap(formatModes),
		...lead === "fastest" ? variants.flatMap(formatOutside) : []
	];
}
function formatRow(variant, nameWidth) {
	const { summary, ratio, interval, heapBytes, arrayBufferBytes } = variant;
	const cells = [
		formatTime(summary.fastest),
		formatTime(summary.median),
		`${(summary.spread * 100).toFixed(1)}%`,
		`${formatRatio(ratio)}×`,
		interval == null ? "" : `${formatRatio(interval[0])}–${formatRatio(interval[1])}`,
		heapBytes == null ? "–" : formatBytes(heapBytes),
		arrayBufferBytes == null ? "–" : formatBytes(arrayBufferBytes)
	];
	return `  ${variant.name.padEnd(nameWidth)}${cells.map((cell, i) => padCell(cell, COLUMNS[i][1])).join("")}`;
}
const GAP = " ";
function padCell(cell, width) {
	return GAP + cell.padStart(width - 1);
}
function formatResolution(resolution, variants) {
	if (resolution == null) return [];
	let shortest = 1e400;
	for (const { summary, repetitions } of variants) shortest = Math.min(shortest, summary.median * repetitions);
	const times = Math.round(shortest / resolution);
	if (times >= ROUND_TICKS) return [];
	return [`  median rounds are as short as ${times} times the timer's resolution, of ${formatTime(resolution)}: a sample time of ${formatTime(ROUND_TICKS * resolution)} or more gives ${ROUND_TICKS}`];
}
function formatModes({ name, summary }) {
	const { modes } = summary;
	if (modes == null) return [];
	const { fast, slow } = modes;
	return [`  ${name}: two modes, ${fast.rounds} rounds near ${formatTime(fast.median)} and ${slow.rounds} near ${formatTime(slow.median)}`];
}
function formatOutside({ name, ratio, interval }) {
	if (interval == null) return [];
	const [low, high] = interval;
	const reach = 1.05;
	if (ratio >= low / reach && ratio <= high * reach) return [];
	return [`  ${name}: ${formatRatio(ratio)}× by the fastest rounds, but ${formatRatio(low)}–${formatRatio(high)}× round by round`];
}
function formatTime(nanoseconds) {
	const [value, unit] = nanoseconds < 1e3 ? [nanoseconds, "ns"] : nanoseconds < 1e6 ? [nanoseconds / 1e3, "µs"] : nanoseconds < 1e9 ? [nanoseconds / 1e6, "ms"] : [nanoseconds / 1e9, "s"];
	return `${toSignificant(value)} ${unit}`;
}
function formatBytes(bytes) {
	return `${Math.max(0, Math.round(bytes)).toLocaleString("en-US")} B`;
}
function formatRatio(ratio) {
	return toSignificant(ratio);
}
function toSignificant(value) {
	if (value > 0 && value < .1) return value.toPrecision(2);
	if (value < 10) return value.toFixed(2);
	return value < 100 ? value.toFixed(1) : value.toFixed(0);
}
function formatJson(value) {
	return `${JSON.stringify(value, null, 2).replaceAll(STRING_OR_NUMBER_ARRAY, joinNumbers)}\n`;
}
const STRING_OR_NUMBER_ARRAY = /"(?:[^"\\]|\\.)*"|\[\s+([\d.e+-]+(?:,\s+[\d.e+-]+)*)\s+\]/g;
function joinNumbers(match, numbers) {
	return numbers ? `[${numbers.replaceAll(/,\s+/g, ", ")}]` : match;
}
// source/core/command-line.ts
const OPTIONS = {
	values: new Set([
		"rounds",
		"warmup-rounds",
		"sample-ms",
		"filter",
		"json",
		"v8-filter"
	]),
	flags: new Set([
		"aa",
		"heap",
		"v8-report"
	])
};
function parseOptions(args) {
	const { values, flags } = readArguments(args, OPTIONS);
	return {
		rounds: integerOption(values.get("rounds"), "--rounds", 1, DEFAULT_OPTIONS.rounds),
		warmupRounds: integerOption(values.get("warmup-rounds"), "--warmup-rounds", 0, DEFAULT_OPTIONS.warmupRounds),
		sampleTime: sampleTimeOption(values.get("sample-ms")),
		aa: flags.get("aa") ?? DEFAULT_OPTIONS.aa,
		heap: flags.get("heap") ?? DEFAULT_OPTIONS.heap,
		filter: filterOption(values.get("filter"), "--filter"),
		json: values.get("json"),
		v8Report: (flags.get("v8-report") ?? false) || values.get("v8-filter") != null,
		v8Filter: filterOption(values.get("v8-filter"), "--v8-filter")
	};
}
function measureAndPrint(groups, options, runtime, print) {
	print(describeRun(runtime.description, {
		...options,
		filter: options.filter?.source ?? ""
	}));
	return measureGroups(groups, {
		...options,
		onGroup: (group) => {
			for (const line of formatGroup(group)) print(line);
		}
	}, runtime);
}
function filterOption(value, name) {
	if (value == null) return;
	try {
		return new RegExp(value, "u");
	} catch (error) {
		throw new SyntaxError(`Expected ${name} to be a regular expression, got ${value}`, { cause: error });
	}
}
function integerOption(value, name, least, otherwise) {
	const number = value == null ? otherwise : /^\d+$/.test(value) ? Number(value) : NaN;
	if (!Number.isInteger(number) || number < least) throw new RangeError(`Expected ${name} to be an integer of at least ${least}, got ${value}`);
	return number;
}
function sampleTimeOption(value) {
	const number = value == null ? DEFAULT_OPTIONS.sampleTime : Number(value);
	if (!(number > 0 && number < 1e400)) throw new RangeError(`Expected --sample-ms to be a positive number, got ${value}`);
	return number;
}
// source/core/timer-source.ts
function timerSource(id) {
	return loopSource("run()", id);
}
function asyncTimerSource(id) {
	return loopSource("await run()", id);
}
function loopSource(call, id) {
	return `let result;
        const start = performance.now();
        for (let i = 0; i < repetitions; i++) {
            result = ${call};
        }
        const elapsed = performance.now() - start;
        globalThis.benkSink = result;
        return elapsed; // timer ${id}`;
}
// source/d8/runtime.ts
const INT32_TAG = "I".charCodeAt(0);
function smallIntegerBits() {
	const bytes = new Uint8Array(d8.serializer.serialize(2 ** 30));
	let at = 1;
	while (bytes[at] >= 128) at++;
	return bytes[at + 1] === INT32_TAG ? 32 : 31;
}
const AsyncFunction = async function() {}.constructor;
let timers = 0;
var D8Runtime = class {
	heap = void 0;
	get description() {
		return describeD8();
	}
	createTimer() {
		return new Function("run", "repetitions", timerSource(timers++));
	}
	createAsyncTimer() {
		return new AsyncFunction("run", "repetitions", asyncTimerSource(timers++));
	}
};
function describeD8() {
	const v8 = version();
	return {
		name: "d8",
		version: v8,
		engine: `V8 ${v8}`,
		platform: os.name,
		arch: "unknown",
		cpu: "unknown",
		flags: ["unknown"],
		processState: [`${smallIntegerBits()}-bit small integers`]
	};
}
// source/d8/bench.ts
async function bench(groups, options = {}) {
	const { json, v8Report, v8Filter, ...command } = parseOptions(options.args ?? scriptArguments());
	if (v8Report) throw new Error(`Expected no --v8-report${v8Filter == null ? "" : " or --v8-filter"} in d8, which can't run the script again: run it with benk-d8, as benk-d8 bench.mjs -- --v8-report`);
	const runtime = options.runtime ?? new D8Runtime();
	const toStdout = json === "-";
	const printLine = options.print ?? (toStdout ? printErr : print);
	if (json != null && !toStdout) checkFile(json);
	const result = await measureAndPrint(groups, {
		...command,
		heap: command.heap && countsBytes(runtime)
	}, runtime, printLine);
	if (toStdout) (options.write ?? write)(formatJson(result));
	else if (json != null) writeResults(json, formatJson(result));
	return result;
}
function scriptArguments() {
	return globalThis.arguments ?? [];
}
function countsBytes(runtime) {
	return runtime.heap != null || runtime.arrayBuffers != null;
}
function checkFile(path) {
	let bytes = new ArrayBuffer(0);
	try {
		bytes = readbuffer(path);
	} catch {}
	writeResults(path, bytes);
}
function writeResults(path, data) {
	try {
		writeFile(path, data);
	} catch (error) {
		throw new Error(`Expected d8 to write the file of --json, got ${path}`, { cause: error });
	}
}
// test/fixtures/v8/bench.ts
const SIZE = 1e3;
const integers = Array.from({ length: SIZE }, (_, i) => i);
const doubles = Array.from({ length: SIZE }, (_, i) => i + .5);
let checksum = 0;
for (let i = 0; i < 1e6; i++) checksum = (checksum + i * i) % 1000003;
function sum(values) {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}
function mix(seed) {
	let h = seed | 0;
	h = Math.imul(h ^ h >>> 16, 73244475);
	h = Math.imul(h ^ h >>> 16, 73244475);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 15, 739982445);
	h = Math.imul(h ^ h >>> 12, 695872825);
	h ^= h >>> 15;
	h = Math.imul(h ^ h >>> 13, 1540483477);
	h = Math.imul(h ^ h >>> 11, 461845907);
	h ^= h >>> 14;
	h = Math.imul(h ^ h >>> 16, 2246822507);
	h = Math.imul(h ^ h >>> 13, 3266489909);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 17, 2146121005);
	h = Math.imul(h ^ h >>> 15, 2221713035);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 16, 73244475);
	h = Math.imul(h ^ h >>> 16, 73244475);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 15, 739982445);
	h = Math.imul(h ^ h >>> 12, 695872825);
	h ^= h >>> 15;
	h = Math.imul(h ^ h >>> 13, 1540483477);
	h = Math.imul(h ^ h >>> 11, 461845907);
	h ^= h >>> 14;
	h = Math.imul(h ^ h >>> 16, 2246822507);
	h = Math.imul(h ^ h >>> 13, 3266489909);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 17, 2146121005);
	h = Math.imul(h ^ h >>> 15, 2221713035);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 16, 73244475);
	h = Math.imul(h ^ h >>> 16, 73244475);
	h ^= h >>> 16;
	h = Math.imul(h ^ h >>> 15, 739982445);
	h = Math.imul(h ^ h >>> 12, 695872825);
	h ^= h >>> 15;
	return h >>> 0;
}
function mixAll(values) {
	let total = 0;
	for (let i = 0; i < values.length; i += 10) total += mix(values[i]);
	return total;
}
const statistics = { "mean, μ": (values) => sum(values) / values.length };
let calls = checksum % 2;
await bench([{
	name: "sums",
	variants: [
		{
			name: "integers",
			run: () => sum(integers)
		},
		{
			name: "mean",
			run: () => statistics["mean, μ"](integers)
		},
		{
			name: "switching",
			run: () => sum(++calls < 2e4 ? integers : doubles)
		},
		{
			name: "mixed",
			run: () => mixAll(integers)
		}
	]
}]);

//# sourceMappingURL=bench.mjs.map