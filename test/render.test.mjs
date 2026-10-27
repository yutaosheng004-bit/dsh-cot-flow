// Assembly + render checks for dsh-cot-flow.
// The scanner test proves segmentation; this one proves the wiring: what the
// plugin registers on the slot, and that the rendered tree keeps every settled
// paragraph's text identity stable across streamed deltas (which is the whole
// reason the Markdown parse stops repeating).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "lib", "client.js");

let loaded = null;
globalThis.window = {
	__ModuleLoader__: {
		load(meta) {
			loaded = meta;
		}
	}
};

// Minimal DOM so apply()' styles effect can run.
const styleNodes = [];
globalThis.document = {
	createElement(tag) {
		return { tag, dataset: {}, textContent: "", remove() {} };
	},
	head: {
		appendChild(node) {
			styleNodes.push(node);
		}
	}
};

// Storage stub for the durable probe: the plugin mirrors its first few renders
// here so the takeover can be confirmed after the window is gone.
const probeWritesSeen = [];
globalThis.window.localStorage = {
	setItem(key, value) {
		probeWritesSeen.push({ key, value });
	}
};

// eslint-disable-next-line no-eval
eval(fs.readFileSync(entry, "utf8"));
if (!loaded || loaded.id !== "dsh-cot-flow") throw new Error("bundle did not register itself");

const requireStub = (id) => {
	if (id === "react") return { useRef, useMemo: (f) => f(), memo: (c) => c };
	return {
		jsx: (type, props, key) => ({ type, props, key }),
		jsxs: (type, props, key) => ({ type, props, key }),
		Fragment: Symbol.for("Fragment")
	};
};

// The component tree is rendered by calling the function component directly, so
// hooks are backed by a single persistent slot each. One reasoning row is on
// screen at a time, which is exactly what this emulates.
let currentRef = null;
function useRef(initial) {
	if (currentRef === null) currentRef = { current: initial };
	return currentRef;
}
function resetHooks() {
	currentRef = null;
}

const api = loaded.factory(requireStub);
const failures = [];
function check(name, cond, extra) {
	if (cond) {
		console.log("  ok   " + name);
	} else {
		failures.push(name + (extra === undefined ? "" : " — " + extra));
		console.log("  FAIL " + name + (extra === undefined ? "" : " — " + extra));
	}
}

// ---------------------------------------------------------------- assembly
console.log("assembly");
const registered = [];
let effectLabels = [];
const ctx = {
	logger: { error: (m) => failures.push("logger.error: " + m) },
	effect(fn, label) {
		effectLabels.push(label);
		const dispose = fn();
		return dispose;
	},
	slots: {
		inject(name, factory) {
			check("inject targets reasoning.body", name === "conversation.chat.reasoning.body", name);
			return factory();
		},
		register(meta, Component) {
			registered.push({ meta, Component });
			return () => {};
		}
	}
};
api.apply(ctx);

check("registers exactly one component", registered.length === 1, String(registered.length));
const reg = registered[0] || { meta: {}, Component: null };
check("registers on reasoning.body", reg.meta.name === "conversation.chat.reasoning.body", String(reg.meta.name));
check("priority beats the official 100", reg.meta.priority === 50, String(reg.meta.priority));
check("installs the stylesheet", styleNodes.length === 1 && styleNodes[0].textContent.includes("[data-cot-flow]"));
check("declares two effects", effectLabels.length === 2, effectLabels.join(" | "));
check("exports apply/inject", typeof api.apply === "function" && Array.isArray(api.inject));

// ------------------------------------------------------------------ render
console.log("render");
const Body = reg.Component;

function renderBody(text, running, renderer) {
	resetHooks();
	return Body({ text, running, renderFactorySlot: renderer, t: (k) => k });
}

const contentCalls = [];
const renderer = (slotName, args) => {
	contentCalls.push({ slotName, serial: args.text });
	return { markdown: args.text, running: args.running };
};

const PARA_A = "First settled paragraph with `code` and **bold**.";
const PARA_B = "Second settled paragraph.\nIt spans two lines on purpose.";
const TAIL_1 = "The tail is still streaming";

let tree = renderBody([PARA_A, PARA_B, TAIL_1].join("\n\n"), true, renderer);
check("root is the flow container", tree && tree.type === "div" && tree.props["data-cot-flow"] === "");
check("counts settled segments", tree && tree.props["data-cot-flow-segments"] === "2", tree && tree.props["data-cot-flow-segments"]);

const kids = tree && tree.props.children && tree.props.children.props.children;
check("renders settled + tail", Array.isArray(kids) && kids.length === 3, String(kids && kids.length));

const segs = (Array.isArray(kids) ? kids : []).map((node) => node.props);
check("settled segments are not streaming", segs[0] && segs[0].streaming === false && segs[1].streaming === false);
check("tail follows the running flag", segs[2] && segs[2].streaming === true);
check("settled text preserved verbatim", segs[0] && segs[0].text === PARA_A, segs[0] && segs[0].text);
check("inner newline preserved", segs[1] && segs[1].text === PARA_B, segs[1] && segs[1].text);
check("segment text carries no trailing blank line", segs[0] && !segs[0].text.endsWith("\n\n"));
// Element trees are inert, so walk them and call every function component the
// way React would: that is when CotFlowSeg hands a paragraph to the factory slot.
function expand(node) {
	if (Array.isArray(node)) return node.map(expand);
	if (node === null || node === undefined || typeof node !== "object") return node;
	if (typeof node.type === "function") return expand(node.type(node.props));
	if (node.props && node.props.children !== undefined) {
		const kids = node.props.children;
		const next = Array.isArray(kids) ? kids.map(expand) : [expand(kids)];
		return { ...node, props: { ...node.props, children: next } };
	}
	return node;
}
function collect(node, out = []) {
	if (Array.isArray(node)) {
		for (const child of node) collect(child, out);
		return out;
	}
	if (node === null || typeof node !== "object") return out;
	out.push(node);
	collect(node.props && node.props.children, out);
	return out;
}

contentCalls.length = 0;
const expanded = expand(tree);
const flat = collect(expanded);
const segNodes = flat.filter((n) => n && n.type === "div" && n.props && "data-cot-flow-seg" in n.props);
check("one wrapper per rendered segment", segNodes.length === 3, String(segNodes.length));
check(
	"delegates to the factory slot",
	contentCalls.length === 3 && contentCalls[0].slotName === "conversation.chat.reasoning.content",
	String(contentCalls.length) + " calls, first=" + (contentCalls[0] && contentCalls[0].slotName)
);
const pick = (node) => (Array.isArray(node) ? node[0] : node);
check(
	"settled paragraphs render non-streaming markdown",
	segNodes[0] && pick(segNodes[0].props.children).running === false,
	JSON.stringify(pick(segNodes[0] && segNodes[0].props.children))
);
check(
	"only the tail renders as streaming markdown",
	segNodes.filter((n) => pick(n.props.children).running === true).length === 1
);

// -------------------------------------------------------------- stability
console.log("stream stability");
const rendererRef = renderer;
let prevTexts = null;
const textIdentities = [];
for (let i = 0; i < 40; i += 1) {
	const running = "The tail is still streaming " + "x".repeat(i + 1);
	renderBody([PARA_A, PARA_B, running].join("\n\n"), true, rendererRef);
	const now = [PARA_A, PARA_B];
	if (prevTexts !== null) {
		for (let k = 0; k < now.length; k += 1) {
			if (prevTexts[k] !== now[k]) textIdentities.push("changed@" + i + ":" + k);
		}
	}
	prevTexts = now;
}
// The settled texts are the very same string literals each render, so a memo
// comparator on text alone keeps those subtree parses from ever repeating.
check("settled segments keep identical text across deltas", textIdentities.length === 0, textIdentities.join(","));

// A delta that only extends the tail must not restructure settled segments.
resetHooks();
const before = renderBody(["one", "two", "tail"].join("\n\n"), true, renderer);
const beforeKids = before.props.children.props.children;
const antiRegress = renderBody(["one", "two", "tail grows"].join("\n\n"), true, renderer);
const afterKids = antiRegress.props.children.props.children;
check(
	"extending the tail keeps the same segment count",
	beforeKids.length === afterKids.length && afterKids.length === 3,
	String(beforeKids.length) + "->" + String(afterKids.length)
);
check("extending the tail leaves paragraph one untouched", afterKids[0].props.text === "one");

// ------------------------------------------------------------ edge shapes
console.log("edge shapes");
const empty = renderBody("", false, renderer);
check("empty text renders nothing", empty === null, String(empty));

const onlyTail = renderBody("just one paragraph, unclosed", true, renderer);
check(
	"single unclosed paragraph renders as one streaming tail",
	onlyTail && onlyTail.props["data-cot-flow-segments"] === "0" && onlyTail.props.children.props.children.length === 1,
	onlyTail && onlyTail.props["data-cot-flow-segments"]
);

const noRenderer = renderBody("hello", true, undefined);
check("missing factory renderer degrades to null", noRenderer === null, String(noRenderer));

const stats = globalThis.window.__dshCotFlow;
check("exposes diagnostics", stats && stats.renders > 0 && stats.scans > 0, JSON.stringify(stats));

console.log("durable probe");
check("writes the probe on render", probeWritesSeen.length > 0, String(probeWritesSeen.length));
check("probe writes are capped", probeWritesSeen.length <= 4, String(probeWritesSeen.length));
check("probe uses its own key", probeWritesSeen.every((w) => w.key === "dsh-cot-flow:probe"));
let probePayload = null;
try {
	probePayload = JSON.parse(probeWritesSeen[0].value);
} catch (_) {
	probePayload = null;
}
check(
	"probe payload carries render counters",
	probePayload !== null && typeof probePayload.renders === "number" && typeof probePayload.at === "string",
	probeWritesSeen[0] && probeWritesSeen[0].value
);

if (failures.length > 0) {
	console.error("\n" + failures.length + " check(s) failed:");
	for (const f of failures) console.error(" - " + f);
	process.exitCode = 1;
} else {
	console.log("\nall render checks passed");
}