// Top-bar logo: hovering slides the "<>" apart to reveal the version number;
// clicking it pins the version so it stays after the pointer leaves.

const HOVER_DELAY = 700

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

const versionOf = () => String(window.code?.version ?? "").trim()

// Writes the version to the reveal. Falls back to window.code.version (the
// app holds both its own default and the /version.json value there); an
// explicit value wins so a direct fetch can fill in fast. The emphasised digit
// is the first non-zero part of the version (e.g. the "8" in "0.8.0") — while
// the major number is 0 it means the first non-zero part is the highlight.
// Shows the experimental-build hammer (see the CSS) when the build channel
// says experimental.
const syncExperimental = (logo) => {
	logo.classList.toggle("experimental", window.code?.experimental === true)
}

const setVersion = (logo, explicit) => {
	const major = logo.querySelector(".logo-version .major")
	const lead = logo.querySelector(".logo-version .version-lead")
	const tail = logo.querySelector(".logo-version .version-tail")
	if (!(major && lead && tail)) return
	const str = String(explicit ?? versionOf()).trim()
	const parts = str.split(".")
	let idx = parts.findIndex((p) => p !== "" && p !== "0")
	if (idx === -1) idx = 0
	major.textContent = parts[idx] ?? ""
	lead.textContent = idx > 0 ? parts.slice(0, idx).join(".") + "." : ""
	tail.textContent = idx < parts.length - 1 ? "." + parts.slice(idx + 1).join(".") : ""
}

const initLogo = () => {
	const logo = document.getElementById("logo")
	if (!logo) return

	const name = logo.querySelector(".logo-name")
	if (name && !name.querySelector(".logo-letter")) {
		const text = name.textContent
		name.textContent = ""
		for (const char of text) {
			const letter = document.createElement("span")
			letter.className = "logo-letter"
			letter.textContent = char
			name.appendChild(letter)
		}
	}

	setVersion(logo)
	syncExperimental(logo)
	fetch("/version.json")
		.then((response) => (response.ok ? response.json() : null))
		.then((data) => {
			if (data?.version) setVersion(logo, data.version)
			syncExperimental(logo)
		})
		.catch(() => {})

	let hoverTimer = null
	let pinned = false

	const isOpen = () => logo.classList.contains("open")
	const setState = (open) => {
		if (open) setVersion(logo)
		syncExperimental(logo)
		logo.classList.toggle("open", open)
		logo.setAttribute("aria-expanded", open ? "true" : "false")
	}

	logo.addEventListener("pointerenter", () => {
		clearTimeout(hoverTimer)
		if (pinned || isOpen()) return
		hoverTimer = setTimeout(() => setState(true), reduceMotion.matches ? 0 : HOVER_DELAY)
	})

	logo.addEventListener("pointerleave", () => {
		clearTimeout(hoverTimer)
		if (!pinned) setState(false)
	})

	logo.addEventListener("click", () => {
		if (isOpen()) {
			pinned = !pinned
			if (!pinned) setState(false)
		} else {
			pinned = true
			setState(true)
		}
	})

	logo.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			logo.click()
		}
	})
}

initLogo()