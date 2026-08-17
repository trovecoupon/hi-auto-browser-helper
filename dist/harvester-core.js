//#region harvester/core/scorer.ts
var e = /^[A-Z0-9][A-Z0-9_-]{1,30}[A-Z0-9]$|^[A-Z0-9]{3}$/, t = /* @__PURE__ */ new Set(/* @__PURE__ */ "COPY.COPIED.SHOW.REVEAL.CLICK.HERE.TERMS.DETAILS.SALE.OFF.FREE.DEAL.SUBMIT.VIEW.MORE.NULL.UNDEFINED.TRUE.FALSE.USD.VND.HTTP.HTTPS.WWW.HTML.JSON.GET.POST".split(".")), n = /* @__PURE__ */ new Set([
	"ACCOUNT",
	"APPLY",
	"BACK",
	"BUTTON",
	"CHECKOUT",
	"CLOSE",
	"CODE",
	"COUPON",
	"DISCOUNT",
	"EMAIL",
	"ENTER",
	"LOGIN",
	"NEXT",
	"OFFER",
	"ORDER",
	"PASSWORD",
	"PROMO",
	"REGISTER",
	"SEARCH",
	"SIGNUP",
	"VOUCHER"
]);
function r(e) {
	return new Set(Array.from(e ?? [], (e) => i(e)));
}
function i(e) {
	return e.trim().replace(/^["'“”‘’`]+|["'“”‘’`,.;:!?]+$/gu, "").toUpperCase();
}
function a(e) {
	return /(?:https?:\/\/|www\.|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/iu.test(e);
}
function o(e) {
	return /(?:[$€£¥₫]\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:USD|EUR|GBP|VND)\b)/iu.test(e);
}
function s(e) {
	return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/u.test(e.trim());
}
function c(e) {
	return /^#[0-9A-F]{3}(?:[0-9A-F]{3})?$/iu.test(e.trim());
}
function l(e) {
	return /^&(?:#\d+|#x[0-9A-F]+|[A-Z][A-Z0-9]+);$/iu.test(e.trim());
}
function u(n, u = {}) {
	let d = i(n), f = r(u.allowCodes), p = r(u.blockCodes);
	return f.has(d) ? {
		valid: !0,
		code: d
	} : d.length < 3 || d.length > 32 ? {
		valid: !1,
		code: d,
		reason: "length"
	} : a(n) ? {
		valid: !1,
		code: d,
		reason: "url_or_email"
	} : o(n) ? {
		valid: !1,
		code: d,
		reason: "money"
	} : s(n) ? {
		valid: !1,
		code: d,
		reason: "date"
	} : c(n) ? {
		valid: !1,
		code: d,
		reason: "hex_color"
	} : l(n) ? {
		valid: !1,
		code: d,
		reason: "html_entity"
	} : e.test(d) ? t.has(d) || p.has(d) ? {
		valid: !1,
		code: d,
		reason: "blocklist"
	} : {
		valid: !0,
		code: d
	} : {
		valid: !1,
		code: d,
		reason: "characters"
	};
}
function d(e, t = {}) {
	let r = u(e.rawCode, t.domainOverrides);
	if (!r.valid) return {
		code: r.code,
		confidence: 0,
		decision: "reject",
		hardValid: !1,
		reasons: [`reject:${r.reason ?? "invalid"}`]
	};
	let i = r.code, a = [], o = 0, s = (e, t) => {
		o += e, a.push(`${e > 0 ? "+" : ""}${e}:${t}`);
	};
	return e.detectedBy.includes("clipboard") && s(50, "clipboard"), e.detectedBy.includes("network") && s(40, "network"), e.detectedBy.includes("clickdiff") && s(30, "clickdiff"), e.style?.semanticClass && s(20, "semantic_style"), e.explicitLabel && s(20, "explicit_coupon_label"), e.nearKeyword && s(15, "near_keyword"), e.rawCode === e.rawCode.toUpperCase() && s(10, "uppercase"), /[A-Z]/u.test(i) && /\d/u.test(i) && s(5, "letters_and_numbers"), (t.commonWords ?? n).has(i) && s(-25, "common_word"), (e.occurrenceCount ?? 0) > 30 && s(-20, "too_frequent"), o = Math.max(0, Math.min(100, o)), e.detectedBy.includes("ocr") && (o = Math.min(59, o)), {
		code: i,
		confidence: o,
		decision: o >= 60 ? "auto_save" : o >= 35 ? "review" : "reject",
		hardValid: !0,
		reasons: a
	};
}
//#endregion
//#region harvester/core/text-extractor.ts
var f = "[\"'“”‘’\\x60]?([A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9])[\"'“”‘’\\x60]?", p = [
	"\\b(?:promo(?:tional)?|coupon|voucher|discount|offer)\\s+code\\b",
	"\\b(?:use|apply|enter)\\s+(?:the\\s+)?(?:(?:promo(?:tional)?|coupon|voucher|discount)\\s+)?code\\b",
	"(?<![\\p{L}\\p{N}_])mã\\s+(?:giảm\\s+giá|khuyến\\s+mãi|ưu\\s+đãi)(?![\\p{L}\\p{N}_])",
	"\\b(?:kortings|rabatt)code\\b"
].join("|"), m = RegExp(`(?:${p})\\s*(?:is|là|as)?\\s*[:=\\-–—]?\\s*${f}`, "giu"), h = RegExp(`${f}\\s*(?:is|là|as)?\\s*(?:a|the)?\\s*(?:${p})`, "giu"), g = /^(?:data-)?(?:coupon|promo|voucher|discount|offer|code)(?:[-_:].*)?$/iu, _ = /^(?:alt|title|aria-label|placeholder)$/iu, v = /^value$/iu;
function y(e) {
	let t = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: "\""
	};
	return e.replace(/&#(\d+);/gu, (e, t) => String.fromCodePoint(Number(t))).replace(/&#x([0-9a-f]+);/giu, (e, t) => String.fromCodePoint(Number.parseInt(t, 16))).replace(/&([a-z]+);/giu, (e, n) => t[n.toLowerCase()] ?? e);
}
function b(e) {
	return y(e.replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/giu, " ").replace(/<!--([\s\S]*?)-->/gu, " ").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim());
}
function x(e) {
	let t = /* @__PURE__ */ new Map();
	for (let n of e.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) t.set(n[1].toLowerCase(), y(n[2] ?? n[3] ?? n[4] ?? ""));
	return t;
}
function S(e) {
	let t = [], n = e.replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/giu, " ");
	for (let e of n.matchAll(/<(h[1-6]|p|li|td|th|button|label|div|span)\b([^>]*)>([\s\S]*?)<\/\1>/giu)) {
		let n = b(e[3]);
		if (!n) continue;
		let r = e[1].toLowerCase(), i = x(e[2]), a = `${i.get("class") ?? ""} ${i.get("id") ?? ""}`;
		t.push({
			text: n,
			title: r.startsWith("h") ? n.slice(0, 180) : void 0,
			semanticClass: /coupon|promo|voucher|discount|code/iu.test(a)
		});
	}
	for (let e of n.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/giu)) {
		let n = x(e[2]), r = /(?:^|\s)(?:readonly|disabled)(?:\s|=|$)/iu.test(e[2]);
		for (let [e, i] of n) if (i && (g.test(e) || _.test(e) || v.test(e) && r)) {
			let n = g.test(e) || v.test(e) && r;
			t.push({
				text: i,
				semanticClass: n,
				directCandidate: n
			});
		}
	}
	return t;
}
function C(e, t, n, r, i, a, o) {
	let s;
	try {
		s = new URL(n).hostname.toLowerCase();
	} catch {
		return null;
	}
	return {
		rawCode: e,
		sourceUrl: n,
		hostname: s,
		context: t.slice(0, 300),
		offerTitle: a,
		detectedBy: [r],
		firstSeen: i,
		lastSeen: i,
		explicitLabel: r === "text",
		nearKeyword: r === "text",
		style: { semanticClass: !!o }
	};
}
function w(e, t, n, r, i, a, o = !1) {
	let s = [];
	t.lastIndex = 0;
	for (let c of e.matchAll(t)) {
		if (o && !/[0-9_-]/u.test(c[1]) && c[1] !== c[1].toUpperCase()) continue;
		let t = C(c[1], e, n, "text", r, i, a);
		t && s.push(t);
	}
	return s;
}
function T(e, t) {
	let n = t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return Array.from(e.matchAll(RegExp(`(?<![A-Za-z0-9_-])${n}(?![A-Za-z0-9_-])`, "giu"))).length;
}
function E(e, t, n = Date.now()) {
	let r = S(e), i = `${b(e)} ${r.map((e) => e.text).join(" ")}`, a = [];
	for (let e of r) {
		if (e.directCandidate) {
			let r = C(e.text, e.text, t, "text", n, e.title, e.semanticClass);
			r && a.push(r);
		}
		a.push(...w(e.text, m, t, n, e.title, e.semanticClass)), a.push(...w(e.text, h, t, n, e.title, e.semanticClass, !0));
	}
	let o = /* @__PURE__ */ new Map();
	for (let e of a) {
		let t = e.rawCode.toUpperCase(), n = o.get(t);
		if (e.occurrenceCount = T(i, e.rawCode), !n) {
			o.set(t, e);
			continue;
		}
		n.occurrenceCount = Math.max(n.occurrenceCount ?? 0, e.occurrenceCount), n.style = {
			...n.style,
			semanticClass: n.style?.semanticClass || e.style?.semanticClass
		}, !n.offerTitle && e.offerTitle && (n.offerTitle = e.offerTitle);
	}
	return [...o.values()];
}
function D(e, t = Date.now()) {
	let n;
	try {
		n = new URL(e);
	} catch {
		return [];
	}
	let r = /(?:^|[-_])(coupon|promo|voucher|discount|offer|code)(?:$|[-_])/iu, i = [];
	for (let [e, t] of n.searchParams) r.test(e) && t && i.push({
		key: e,
		value: t
	});
	let a = n.hash.replace(/^#/, "");
	if (a) {
		let e = new URLSearchParams(a.includes("?") ? a.slice(a.indexOf("?") + 1) : a);
		for (let [t, n] of e) r.test(t) && n && i.push({
			key: t,
			value: n
		});
	}
	return i.flatMap(({ key: n, value: r }) => {
		let i = C(r, `${n}=${r}`, e, "url", t);
		return i ? (i.explicitLabel = !0, i.nearKeyword = !0, [i]) : [];
	});
}
//#endregion
//#region harvester/core/dedup.ts
function O(e) {
	let t = 2166136261;
	for (let n = 0; n < e.length; n += 1) t ^= e.charCodeAt(n), t = Math.imul(t, 16777619);
	return (t >>> 0).toString(16).padStart(8, "0");
}
function k(...e) {
	return [...new Set(e.flat())];
}
function A(e, t) {
	return `coupon_${O(`${e.toLowerCase()}\u0000${t.toUpperCase()}`)}`;
}
function j(e, t) {
	return {
		id: A(e.hostname, t.code),
		code: t.code,
		offerTitle: e.offerTitle ?? "",
		description: e.description ?? e.context ?? "",
		conditions: e.conditions ?? "",
		expiresAt: e.expiresAt ?? null,
		sourceUrl: e.sourceUrl,
		hostname: e.hostname,
		detectedBy: [...new Set(e.detectedBy)],
		confidence: t.confidence,
		firstSeen: e.firstSeen,
		lastSeen: e.lastSeen,
		verified: !!e.verified,
		...e.screenshotCrop ? { screenshotCrop: e.screenshotCrop } : {}
	};
}
function M(e, t) {
	return t.length > e.length ? t : e;
}
function N(e, t) {
	if (e.hostname.toLowerCase() !== t.hostname.toLowerCase() || e.code !== t.code) throw Error("Cannot merge coupons with different hostname or code");
	return {
		...e,
		offerTitle: M(e.offerTitle, t.offerTitle),
		description: M(e.description, t.description),
		conditions: M(e.conditions, t.conditions),
		expiresAt: e.expiresAt ?? t.expiresAt,
		sourceUrl: t.confidence > e.confidence ? t.sourceUrl : e.sourceUrl,
		detectedBy: k(e.detectedBy, t.detectedBy),
		confidence: Math.max(e.confidence, t.confidence),
		firstSeen: Math.min(e.firstSeen, t.firstSeen),
		lastSeen: Math.max(e.lastSeen, t.lastSeen),
		verified: e.verified || t.verified,
		screenshotCrop: e.screenshotCrop ?? t.screenshotCrop
	};
}
function P(e) {
	let t = /* @__PURE__ */ new Map();
	for (let n of e) {
		let e = `${n.hostname.toLowerCase()}\u0000${n.code}`, r = t.get(e);
		t.set(e, r ? N(r, n) : n);
	}
	return [...t.values()];
}
//#endregion
export { n as DEFAULT_COMMON_WORDS, A as couponId, P as dedupeCoupons, E as extractTextCandidates, D as extractUrlCandidates, N as mergeCoupon, i as normalizeCode, d as scoreCandidate, j as toCoupon, u as validateCode };

//# sourceMappingURL=harvester-core.js.map