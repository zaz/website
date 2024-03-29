const SVG_NAMESPACE = "http://www.w3.org/2000/svg"

const COLOR_MAP = {
	0: "#222",
	1: "#666",
	2: "#aaa",
	3: "#eee"
}

const BASE_USED_BY = {
	"MD5": 16,
	"SHA256": 32
}

const base16ToBase = (k, base) => {
	let hexit, i, j, l, n, p_num, p_size, parts, ref, ref1
	p_size = Math.log2(base)
	p_num = 4 / p_size
	k = k.toLowerCase().replace(/[^0-9a-z]/g, '')
	parts = []
	for (i = j = 0, ref = k.length; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) {
		hexit = parseInt(k[i], 16)
		for (n = l = 0, ref1 = p_num; 0 <= ref1 ? l < ref1 : l > ref1; n = 0 <= ref1 ? ++l : --l) {
			parts[i * p_num + n] = (hexit >> p_size * (p_num - n - 1)) % base
		}
	}
	return parts
}

const convertBase = (from, to, val) => {
	if (from === 16) {
		return base16ToBase(val, to)
	} else {
		return console.error("Could not convert from base " + from + " to base " + to + ".")
	}
}

const svgCreate = (name, attrs) => {
	let elem, k, v
	elem = document.createElementNS(SVG_NAMESPACE, name)
	if (name === "svg") {
		elem.setAttribute("xmlns", SVG_NAMESPACE)
	}
	if (typeof attrs === "object") {
		for (k in attrs) {
			v = attrs[k]
			elem.setAttribute(k, v)
		}
	}
	return elem
}

const createRect = (x, y, w, h, f) =>
	svgCreate("rect", {
		"x": x,
		"y": y,
		"width": w,
		"height": h,
		"fill": f
	})

const sq = (x, y, fill) =>
	createRect(x, y, 1, 1, fill)

document.addEventListener('DOMContentLoaded', () => {
	let key = document.querySelector("[data-fingerprint-hash-algorithm]")
    if (key == null) {
		return
	}

	let algorithm, colors, digits, fingerprint, g, j, l, n, rect, svg, title, x, y
	svg = svgCreate("svg", {
		"viewBox": "0 0 8 8",
		"alt": this.innerHTML
	})
	g = svgCreate("g")
	svg.appendChild(g)
	title = svgCreate("title")
	title.innerHTML = key.attributes["title"]
	g.appendChild(title)
	algorithm = key.attributes["data-fingerprint-hash-algorithm"].value
	fingerprint = key.attributes["title"].value
	digits = convertBase(BASE_USED_BY[algorithm], 4, fingerprint)
	colors = digits.map( d => {
		return COLOR_MAP[d]
	})
	n = 0
	for (y = j = 0; j <= 7; y = ++j) {
		for (x = l = 0; l <= 7; x = ++l) {
			rect = sq(x, y, colors[n])
			g.appendChild(rect)
			n++
		}
	}
	key.replaceWith(svg)
})
