window.__ModuleLoader__.load({
	id: "dsh-cot-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const Fragment = jsxRuntime.Fragment;

		const NS = "dsh-cot-flow";
		const inject = ["slots"];

		/**
		 * Why this plugin exists
		 * ---------------------
		 * The official reasoning body hands the whole thinking text to MarkdownText
		 * on every streamed delta. That parse is O(length of text) per delta, so a
		 * long reasoning block costs O(n * deltas) — the longer the thinking and the
		 * earlier in the conversation, the more the UI stutters.
		 *
		 * Here the text is split at blank lines (outside fenced code) into paragraphs.
		 * Every paragraph except the streaming tail is final: its text string never
		 * changes again, so its Markdown host component re-renders zero times. Only
		 * the short tail is re-parsed per delta, which keeps the cost per frame
		 * roughly constant regardless of how long the thinking block grew.
		 */

		const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
		const RULE_RE = /^\s{0,4}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

		/**
		 * A fence line, with the parts that decide whether it opens or closes.
		 * CommonMark only closes a fence with the same character, at least as
		 * long, and without an info string — otherwise ```` ```js ```` typed
		 * inside a block would end it early.
		 */
		function fenceOf(line) {
			const m = FENCE_RE.exec(line);
			if (!m) return null;
			return { char: m[1][0], len: m[1].length, rest: m[2].trim() };
		}

		/** Diagnostics surface, readable from devtools. */
		function stats() {
			if (!window.__dshCotFlow) {
				window.__dshCotFlow = { renders: 0, scans: 0, scanMs: 0, lastScanMs: 0, segs: 0, chars: 0 };
			}
			return window.__dshCotFlow;
		}

		/**
		 * Durable probe. The in-memory stats vanish with the window, which makes
		 * "did this component ever render?" unanswerable after the fact — the
		 * plugin looks identical whether it took the slot over or never ran.
		 * The first few renders are mirrored into localStorage (then silence, so
		 * no write amplification) which lets the takeover be verified from
		 * outside the renderer.
		 */
		const PROBE_KEY = NS + ":probe";
		let probeWrites = 0;

		function probe(info) {
			if (probeWrites >= 4) return;
			probeWrites += 1;
			try {
				window.localStorage.setItem(PROBE_KEY, JSON.stringify({
					at: new Date().toISOString(),
					renders: info.renders,
					scans: info.scans,
					segs: info.segs,
					chars: info.chars,
					lastScanMs: Math.round(info.lastScanMs * 1000) / 1000,
					scanMs: Math.round(info.scanMs * 1000) / 1000
				}));
			} catch (_) {
				/* storage is optional: diagnostics must never break the UI */
			}
		}

		const ANCHOR = 24;

		function createState() {
			return {
				text: "",
				pos: 0,
				head: "",
				tailAnchor: "",
				inFence: false,
				fenceChar: "",
				fenceLen: 0,
				para: [],
				segs: [],
				tail: ""
			};
		}

		/**
		 * Did `text` merely grow the previous text, or was it replaced?
		 *
		 * Comparing the whole previous prefix would cost O(len) on every delta,
		 * which is exactly what this plugin exists to avoid. The streamed text
		 * only ever grows, so a length check plus the first and last ANCHOR
		 * characters of the previous value is enough: an unrelated replacement
		 * would have to reproduce both anchors to be mistaken for growth.
		 */
		function continues(st, text) {
			const prev = st.text;
			if (prev.length === 0) return true;
			if (text.length < prev.length) return false;
			if (st.head.length !== 0 && !text.startsWith(st.head)) return false;
			if (st.tailAnchor.length !== 0 && !text.startsWith(st.tailAnchor, prev.length - st.tailAnchor.length)) return false;
			return true;
		}

		function flush(st) {
			if (st.para.length !== 0) {
				st.segs.push(st.para.join("\n"));
				st.para = [];
			}
		}

		function handleLine(st, line) {
			if (st.inFence) {
				st.para.push(line);
				const closing = fenceOf(line);
				if (closing && closing.char === st.fenceChar && closing.len >= st.fenceLen && closing.rest === "") {
					st.inFence = false;
					st.fenceChar = "";
					st.fenceLen = 0;
				}
				return;
			}
			const opening = fenceOf(line);
			if (opening) {
				st.para.push(line);
				st.inFence = true;
				st.fenceChar = opening.char;
				st.fenceLen = opening.len;
				return;
			}
			if (line.trim() === "") {
				flush(st);
				return;
			}
			if (RULE_RE.test(line)) return;
			st.para.push(line);
		}

		/**
		 * Advance the segmentation state to cover `text`.
		 *
		 * Streaming appends, so usually only the new tail is scanned (O(delta)).
		 * If the text is replaced or rewound, the state is rebuilt from scratch.
		 */
		function scan(st, text) {
			if (!continues(st, text)) {
				const fresh = createState();
				Object.assign(st, fresh);
			}
			const start = st.pos;
			let i = start;
			const n = text.length;
			while (i < n) {
				const nl = text.indexOf("\n", i);
				if (nl === -1) break;
				handleLine(st, text.slice(i, nl));
				i = nl + 1;
			}
			st.pos = i;
			st.text = text;
			const anchor = Math.min(n, ANCHOR);
			if (anchor !== 0) {
				st.head = text.slice(0, anchor);
				st.tailAnchor = text.slice(n - anchor);
			} else {
				st.head = "";
				st.tailAnchor = "";
			}
			const pending = text.slice(i);
			if (pending.length === 0) {
				st.tail = st.para.join("\n");
			} else {
				st.tail = st.para.length === 0 ? pending : st.para.join("\n") + "\n" + pending;
			}
			return st;
		}

		function useSegments(text) {
			const ref = react.useRef(null);
			if (ref.current === null) ref.current = createState();
			return react.useMemo(() => {
				const st = ref.current;
				const t0 = performance.now();
				scan(st, text);
				const info = stats();
				info.scans += 1;
				info.lastScanMs = performance.now() - t0;
				info.scanMs += info.lastScanMs;
				info.segs = st.segs.length;
				info.chars = text.length;
				return st;
			}, [text]);
		}

		/**
		 * One settled paragraph. The comparator deliberately ignores `render`: the
		 * framework's Factory renderer is stable for the life of the slot, and
		 * comparing it would defeat the memo if the host ever handed over a fresh
		 * closure on re-render. Because `text` for a settled paragraph never changes
		 * again, this component and everything under it (the Markdown parse
		 * included) runs exactly once per paragraph.
		 */
		const CotFlowSeg = react.memo(function CotFlowSeg(props) {
			return jsx("div", {
				"data-cot-flow-seg": "",
				children: props.render("conversation.chat.reasoning.content", {
					text: props.text,
					running: props.streaming
				})
			});
		}, (a, b) => a.text === b.text && a.streaming === b.streaming);

		function CotFlowBody(props) {
			const text = typeof props.text === "string" ? props.text : "";
			const running = props.running === true;
			const renderFactorySlot = props.renderFactorySlot;
			const st = useSegments(text);
			const info = stats();
			info.renders += 1;
			probe(info);

			const segs = st.segs;
			const tail = st.tail;
			if (segs.length === 0 && tail === "") return null;
			if (typeof renderFactorySlot !== "function") return null;

			const children = [];
			for (let index = 0; index < segs.length; index += 1) {
				children.push(jsx(CotFlowSeg, {
					text: segs[index],
					streaming: false,
					render: renderFactorySlot
				}, "s" + index));
			}
			if (tail !== "") {
				children.push(jsx(CotFlowSeg, {
					text: tail,
					streaming: running,
					render: renderFactorySlot
				}, "tail"));
			}
			return jsx("div", {
				"data-cot-flow": "",
				"data-cot-flow-segments": String(segs.length),
				children: jsx(Fragment, { children })
			});
		}

		const CLIENT_STYLES = [
			"[data-cot-flow]{display:flex;flex-direction:column;gap:.62em;}",
			"[data-cot-flow]>[data-cot-flow-seg]{min-width:0;}",
			"[data-cot-flow]>[data-cot-flow-seg]>:first-child{margin-top:0 !important;}",
			"[data-cot-flow]>[data-cot-flow-seg]>:last-child{margin-bottom:0 !important;}"
		].join("\n");

		function log(ctx, message, error) {
			const text = NS + ": " + message + (error === undefined ? "" : " — " + String(error && error.message ? error.message : error));
			try {
				if (ctx && ctx.logger && typeof ctx.logger.error === "function") ctx.logger.error(text);
				else console.error(text);
			} catch (_) {
				/* logging must never break the UI */
			}
		}

		function apply(ctx) {
			ctx.effect(() => {
				try {
					const style = document.createElement("style");
					style.dataset.plugin = NS;
					style.textContent = CLIENT_STYLES;
					document.head.appendChild(style);
					return () => style.remove();
				} catch (error) {
					log(ctx, "stylesheet injection disabled", error);
					return () => {};
				}
			}, NS + ": styles");

			ctx.effect(() => {
				try {
					const dispose = ctx.slots.inject("conversation.chat.reasoning.body", () => {
						try {
							return ctx.slots.register({
								name: "conversation.chat.reasoning.body",
								priority: 50
							}, CotFlowBody);
						} catch (error) {
							log(ctx, "reasoning body registration disabled", error);
							return () => {};
						}
					});
					return typeof dispose === "function" ? dispose : () => {};
				} catch (error) {
					log(ctx, "reasoning body injection disabled", error);
					return () => {};
				}
			}, NS + ": reasoning body");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internal = {
			createState,
			scan
		};
		return module.exports;
	}
});