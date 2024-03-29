(function() {
  var BASE_USED_BY, COLOR_MAP, SVG_NAMESPACE, base16ToBase, convertBase, createRect, sq, svgCreate;

  SVG_NAMESPACE = "http://www.w3.org/2000/svg";

  COLOR_MAP = {
    0: "#222",
    1: "#666",
    2: "#aaa",
    3: "#eee"
  };

  BASE_USED_BY = {
    "MD5": 16,
    "SHA256": 32
  };

  base16ToBase = function(k, base) {
    var hexit, i, j, l, n, p_num, p_size, parts, ref, ref1;
    p_size = Math.log2(base);
    p_num = 4 / p_size;
    k = k.toLowerCase().replace(/[^0-9a-z]/g, '');
    parts = [];
    for (i = j = 0, ref = k.length; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) {
      hexit = parseInt(k[i], 16);
      for (n = l = 0, ref1 = p_num; 0 <= ref1 ? l < ref1 : l > ref1; n = 0 <= ref1 ? ++l : --l) {
        parts[i * p_num + n] = (hexit >> p_size * (p_num - n - 1)) % base;
      }
    }
    return parts;
  };

  convertBase = function(from, to, val) {
    if (from === 16) {
      return base16ToBase(val, to);
    } else {
      return console.error("Could not convert from base " + from + " to base " + to + ".");
    }
  };

  svgCreate = function(name, attrs) {
    var elem, k, v;
    elem = document.createElementNS(SVG_NAMESPACE, name);
    if (name === "svg") {
      elem.setAttribute("xmlns", SVG_NAMESPACE);
    }
    if (typeof attrs === "object") {
      for (k in attrs) {
        v = attrs[k];
        elem.setAttribute(k, v);
      }
    }
    return elem;
  };

  createRect = function(x, y, w, h, f) {
    return svgCreate("rect", {
      "x": x,
      "y": y,
      "width": w,
      "height": h,
      "fill": f
    });
  };

  sq = function(x, y, fill) {
    return createRect(x, y, 1, 1, fill);
  };

  $(document).ready(function() {
    return $("[data-fingerprint-hash-algorithm]").replaceWith(function() {
      var algorithm, colors, digits, fingerprint, g, j, l, n, rect, svg, title, x, y;
      svg = svgCreate("svg", {
        "viewBox": "0 0 8 8",
        "alt": this.innerHTML
      });
      g = svgCreate("g");
      svg.appendChild(g);
      title = svgCreate("title");
      title.innerHTML = $(this).prop("title");
      g.appendChild(title);
      algorithm = $(this).data("fingerprint-hash-algorithm");
      fingerprint = $(this).prop("title");
      digits = convertBase(BASE_USED_BY[algorithm], 4, fingerprint);
      colors = digits.map(function(d) {
        return COLOR_MAP[d];
      });
      n = 0;
      for (y = j = 0; j <= 7; y = ++j) {
        for (x = l = 0; l <= 7; x = ++l) {
          rect = sq(x, y, colors[n]);
          g.appendChild(rect);
          n++;
        }
      }
      return svg;
    });
  });

}).call(this);
