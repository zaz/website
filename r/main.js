const de_obfuscate = email =>
	email.replace("...", "@").replace(/\.\.\./g, ".")

const init = () => {
	document.querySelectorAll('.eml').forEach( item =>
		item.outerHTML = de_obfuscate(item.outerHTML)
	)

    document.querySelectorAll('a.instant').forEach( item =>
		item.addEventListener('click', load_in_place)
    )
}


const load_in_place = function(event) {
    let href = this.getAttribute('href')
	fetch(href)
		.then(event.preventDefault())
		.then(response => response.text())
        .then(html => {
			const parser = new DOMParser()
            return parser.parseFromString(html, 'text/html')
			             .querySelector('main')
        })
		.then(main =>
            // replace the current <main>'s content with the fetched content
            document.querySelector('main').replaceWith(main)
        )
		.then(() => console.log("Loaded:", href))
		.then(() => document.location = href)
        .catch(error => {
            console.warn('Failed to load content via JavaScript:', error)
        })
}

document.addEventListener('DOMContentLoaded', init);
