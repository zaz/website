const de_obfuscate = (_, email) =>
	email.replace("...", "@").replace(/\.\.\./g, ".")

const init = () => {
	$(".eml").each(function() {
		$(this).html(de_obfuscate)
		if ($(this).attr("href")) {
			return $(this).attr("href", de_obfuscate)
		}
	})


	$('body').on('click', 'a.instant', load_in_place)
	$('body').on('click', 'header a.instant', load_in_place) // this is a mystery
}


const load_in_place = function() {
	let href = $(this).attr('href');
	$('main').load(href + ' main', (response, status, xhr) => {
		if (status == 'success') {
			// history.pushState(null, null, href)
			window.location.href = href
			$(init)
		}
	})
	return false
}

$(window).bind('popstate', function() {
	let href = location.pathname
	$('main').load(href + ' main', (response, status, xhr) => {
		if (status == 'success') {
			$(init)
		}
	})
})


$(document).ready( init )
