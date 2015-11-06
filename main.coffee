---
---

de_obfuscate = (_, email) -> email.replace("...", "@").replace(/\.\.\./g, ".")

$(document).ready( ->
	$(".eml").each( ->
		$(this).html(            de_obfuscate )
		if $(this).attr("href")
			$(this).attr("href", de_obfuscate ) ) )
