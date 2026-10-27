// Node-side checks for the paragraph scanner used by dsh-cot-flow.
// The scanner is plain JS with no React dependency, so it can be exercised
// directly by loading the browser bundle entry with a stubbed module loader.

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

const source = fs.readFileSync(entry, "utf8");
// eslint-disable-next-line no-eval
eval(source);

if (!loaded || loaded.id !== "dsh-cot-flow") throw new Error("bundle did not register itself");

const requireStub = (id) => {
	if (id === "react") return { useRef: () => ({ current: null }), useMemo: (f) => f(), memo: (c) => c };
	return {
		jsx: (type, props) => ({ type, props }),
		jsxs: (type, props) => ({ type, props }),
		Fragment: Symbol("Fragment")
	};
};

const api = loaded.factory(requireStub);
if (typeof api.apply !== "function") throw new Error("apply export missing");
if (!Array.isArray(api.inject)) throw new Error("inject export missing");

const { createState, scan } = api.__internal;

let failures = 0;
function check(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log("ok   " + name);
	} else {
		failures += 1;
		console.log("FAIL " + name + "\n  expected " + e + "\n  actual   " + a);
	}
}

function run(text, chunks) {
	const st = createState();
	if (chunks) {
		let acc = "";
		for (const chunk of chunks) {
			acc += chunk;
			scan(st, acc);
		}
		return st;
	}
	scan(st, text);
	return st;
}

// --- blank line splits paragraphs -------------------------------------------
check("single paragraph stays in the tail", [run("hello").segs, run("hello").tail], [[], "hello"]);
check("blank line closes a paragraph", [run("a\n\nb").segs, run("a\n\nb").tail], [["a"], "b"]);
check("trailing blank line closes everything", [run("a\n\n").segs, run("a\n\n").tail], [["a"], ""]);
check("three blanks collapse to one split", [run("a\n\n\n\nb").segs, run("a\n\n\n\nb").tail], [["a"], "b"]);
check("leading blanks are dropped", [run("\n\na").segs, run("\n\na").tail], [[], "a"]);
check("multi-line paragraph keeps inner newlines", [run("a1\na2\n\nb").segs], [["a1\na2"]]);

// --- fenced code survives blank lines --------------------------------------
check(
	"blank line inside a fence does not split",
	[run("```\nx\n\ny\n```\n\nz").segs, run("```\nx\n\ny\n```\n\nz").tail],
	[["```\nx\n\ny\n```"], "z"]
);
check("tilde fence is honoured", [run("~~~\na\n\nb\n~~~\n\nc").segs], [["~~~\na\n\nb\n~~~"]]);
check("unclosed fence keeps everything in the tail", [run("```\na\n\nb").segs], [[]]);

// --- horizontal rules are dropped -------------------------------------------
check("standalone rule removed", [run("a\n\n---\n\nb").segs, run("a\n\n---\n\nb").tail], [["a"], "b"]);
check("rule inside fence is kept", [run("```\n---\n```\n\nx").segs], [["```\n---\n```"]]);

// --- incremental equals one-shot -------------------------------------------
const long = [
	"第一段想着想着。",
	"",
	"第二段，带 `code` 和 **强调**。",
	"",
	"```js",
	"const a = 1;",
	"",
	"const b = 2;",
	"```",
	"",
	"第三段收尾。"
].join("\n");

const oneShot = run(long);
const chunks = [];
for (let i = 0; i < long.length; i += 7) chunks.push(long.slice(i, i + 7));
const incremental = run(long, chunks);

check("incremental matches one-shot segments", incremental.segs, oneShot.segs);
check("incremental matches one-shot tail", incremental.tail, oneShot.tail);
check("long sample has three segments", oneShot.segs.length, 3);

// --- rewinding text rebuilds state ----------------------------------------
{
	const st = createState();
	scan(st, "a\n\nb\n\nc");
	const before = st.segs.length;
	scan(st, "z\ny");
	check("rewound text rebuilds", [before >= 2, st.segs, st.tail], [true, [], "z\ny"]);
}

// --- fence closing must be exact (CommonMark) -------------------------------
// A line inside a block that merely looks like a fence — with an info string,
// the wrong character, or not long enough — must not end the block early.
check(
	"info string does not close a fence",
	[run("```\nx\n```js\ny\n```\n\nz").segs, run("```\nx\n```js\ny\n```\n\nz").tail],
	[["```\nx\n```js\ny\n```"], "z"]
);
check(
	"tilde fence is not closed by backticks",
	[run("~~~\na\n```\nb\n~~~\n\nz").segs],
	[["~~~\na\n```\nb\n~~~"]]
);
check(
	"shorter fence does not close a longer one",
	[run("````\na\n```\nb\n````\n\nz").segs],
	[["````\na\n```\nb\n````"]]
);
check(
	"longer fence closes a shorter one",
	[run("```\na\n`````\n\nz").segs],
	[["```\na\n`````"]]
);
check(
	"an unclosed fence swallows later blank-line splits",
	[run("```\na\n\nb\n\nc").segs, run("```\na\n\nb\n\nc").tail],
	[[], "```\na\n\nb\n\nc"]
);

// --- continuation detection is cheap ---------------------------------------
{
	const text = "第一段。\n\n第二段带 `code`。\n\n第三段尾巴";
	const st = createState();
	let monotonic = true;
	let prevPos = 0;
	for (let i = 1; i <= text.length; i += 1) {
		scan(st, text.slice(0, i));
		if (st.pos < prevPos) monotonic = false;
		prevPos = st.pos;
	}
	const once = run(text);
	check("char-by-char appending converges on the one-shot result", [st.segs, st.tail], [once.segs, once.tail]);
	check("consumed position never rewinds while appending", monotonic, true);
}

{
	const st = createState();
	scan(st, "a".repeat(28) + "\n\n" + "b".repeat(28));
	const before = st.segs.length;
	scan(st, "x".repeat(28) + "\n\n" + "y".repeat(28));
	check(
		"same-length replacement is detected",
		[before, st.segs, st.tail],
		[1, ["x".repeat(28)], "y".repeat(28)]
	);
}

{
	const st = createState();
	scan(st, "结论是 A");
	scan(st, "结论是 B");
	check("a rewritten tail is rescanned", st.tail, "结论是 B");
}

// --- no text is lost: segments + tail reproduce the non-blank source lines --
{
	const st = run(long);
	const lines = st.segs
		.concat(st.tail === "" ? [] : [st.tail])
		.join("\n")
		.split("\n")
		.filter((line) => line.trim() !== "");
	const sourceLines = long.split("\n").filter((line) => line.trim() !== "");
	check("content preserved", lines, sourceLines);
}

console.log(failures === 0 ? "\nall checks passed" : "\n" + failures + " check(s) failed");
process.exit(failures === 0 ? 0 : 1);