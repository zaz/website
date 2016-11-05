---
---

SVG_NAMESPACE = "http://www.w3.org/2000/svg"
COLOR_MAP = { 0:"#222", 1:"#666", 2:"#aaa", 3:"#eee" }
BASE_USED_BY = { "MD5":16, "SHA256":32 }

base16ToBase = (k, base) ->
	# Partition size in bits and number of partitions:
	p_size = Math.log2(base)
	p_num = 4/p_size
	k = k.toLowerCase().replace(/[^0-9a-z]/g,'')
	parts = []
	for i in [0...k.length]
		hexit = parseInt(k[i], 16)
		for n in [0...p_num]
			parts[i*p_num+n] = ( hexit >> p_size * (p_num - n - 1) ) % base
	parts

convertBase = (from, to, val) ->
	if from == 16 then return base16ToBase(val, to)
	else console.error("Could not convert from base #{from} to base #{to}.")

svgCreate = (name, attrs) ->
	elem = document.createElementNS(SVG_NAMESPACE, name)
	elem.setAttribute("xmlns", SVG_NAMESPACE) if name is "svg"
	elem.setAttribute(k, v) for k, v of attrs if typeof attrs is "object"
	elem

createRect = (x, y, w, h, f) ->
	svgCreate("rect", {"x":x, "y":y, "width":w, "height":h, "fill":f})

sq = (x, y, fill) ->
	createRect(x, y, 1, 1, fill)

$(document).ready( ->
	$("[data-fingerprint-hash-algorithm]").replaceWith( ->
		svg = svgCreate("svg", {"viewBox":"0 0 8 8", "alt":this.innerHTML})
		g = svgCreate("g")
		svg.appendChild(g)

		title = svgCreate("title")
		title.innerHTML = $(this).prop("title")
		g.appendChild(title)

		algorithm = $(this).data("fingerprint-hash-algorithm")
		fingerprint = $(this).prop("title")
		digits = convertBase(BASE_USED_BY[algorithm], 4, fingerprint)

		colors = digits.map (d) -> COLOR_MAP[d]

		n = 0
		for y in [0..7]
			for x in [0..7]
				rect = sq(x, y, colors[n])
				g.appendChild(rect)
				n++

		svg ))
