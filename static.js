var SVG_NAMESPACE = "http://www.w3.org/2000/svg"

function key_to_base(k, base) {
	// Partition size in bits and number of partitions:
	p_size = Math.log2(base);
	p_num = 4/p_size;
	k = k.toLowerCase().replace(/[^0-9a-z]/g,'');
	parts = [];
	for (i = 0; i < k.length; i++) {
		hexit = parseInt(k[i], 16)
		for (n = 0; n < p_num; n++) {
			parts[i*p_num+n] = ( hexit >> p_size * (p_num - n - 1) ) % base;
		}
	}
	return parts;
}

function svg_create(name, attrs) {
	elem = document.createElementNS(SVG_NAMESPACE, name);
	if (name === "svg") { elem.setAttribute("xmlns", SVG_NAMESPACE)}
	if (typeof(attrs) === "object") {
		for (a in attrs) {
			elem.setAttribute(a, attrs[a]);
		}
	}
	return elem
}

function create_rect(x, y, w, h, f) {
	return svg_create("rect", {"x":x, "y":y, "width":w, "height":h, "fill":f});
}
function sq(x, y, fill) { return create_rect(x, y, 1, 1, fill); }

$(document).ready( function() {
	$("key-fingerprint").each( function() {
		var svg = svg_create("svg", {"viewBox":"0 0 8 8", "alt":this.innerHTML});
		var g = svg_create("g");
		svg.appendChild(g);

		var title = svg_create("title");
		title.innerHTML = this.innerHTML;
		g.appendChild(title);

		var color_map = {0:"#222", 1:"#666", 2:"#aaa", 3:"#eee"};
		var digits = key_to_base($(this)[0].innerHTML, 4);
		var colors = digits.map(function(d) { return color_map[d]; });

		n = 0;
		squares = [];
		for (y = 0; y < 8; y++) {
			for(x = 0; x < 8; x++) {
				var rect = sq(x, y, colors[n]);
				g.appendChild(rect);
				n++;
			}
		}

		$(this).html(svg);
	});
});
