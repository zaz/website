const de_obfuscate = (_, email) =>
	email.replace("...", "@").replace(/\.\.\./g, ".")

$(document).ready( () =>
	$(".eml").each(function() {
		$(this).html(de_obfuscate)
		if ($(this).attr("href")) {
			return $(this).attr("href", de_obfuscate)
		}
	})
)
