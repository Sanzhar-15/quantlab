/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Toolbar/menu icon set (demo-quality overhaul, 2026-06-10).**
 *
 * Every glyph here is a Google **Material Symbols** icon (the *outlined* style at the 20px optical
 * size) -- the exact design system Google Sheets' own toolbar uses -- replacing the prior
 * hand-drawn 16px SVGs, which read visibly off-model next to Excel / Google Sheets (the operator's
 * demo-blocking complaint). Sourced verbatim from the google/material-design-icons repository
 * (https://github.com/google/material-design-icons, `symbols/web/<name>/materialsymbolsoutlined/
 * <name>_20px.svg`), which Google licenses under the **Apache License, Version 2.0**
 * (http://www.apache.org/licenses/LICENSE-2.0). This attribution header is that license's notice;
 * the path data is UNMODIFIED -- only the svg ELEMENT is normalized:
 *   - `width`/`height` 20 -> 18 (our 28px toolbar buttons carry an 18px glyph, Sheets-density);
 *   - `viewBox="0 -960 960 960"` kept VERBATIM (Material Symbols' y-up 960-unit grid -- the path
 *     coordinates only make sense inside it, so it must never be rewritten);
 *   - `fill="currentColor"` added so every glyph inherits the VS Code theme foreground (the same
 *     `color:` inheritance the old inline SVGs relied on -- light AND dark themes keep working);
 *   - `aria-hidden="true"` added: every consuming control carries its own accessible name
 *     (`title`/`aria-label`), so the glyph itself must be invisible to a screen reader.
 *
 * Each fetched file was verified to BE an `<svg>` document at build time (a wrong icon name on
 * raw.githubusercontent.com returns a "404: Not Found" text body, not an svg -- No-Fallbacks: a
 * missing name was re-picked deliberately, never shipped broken). Naming notes for the
 * non-obvious picks:
 *   - `functions` (NOT `function`): Material's sigma glyph -- the Sheets "Functions" button;
 *     `function` is the italic f(x) used for math editors.
 *   - `splitscreen`: the closest Material glyph to "freeze panes" (a viewport split into pinned
 *     panes); Material has no dedicated freeze icon.
 *   - `add_row_below` / `delete`: the insert/delete row-column dropdown anchors (both menus offer
 *     row AND column variants, so one representative glyph anchors each).
 *   - `swap_vert`: the sort toggle (Sheets' A-Z/Z-A affordance); Material's `sort` glyph is the
 *     "stacked filter lines" used for list ordering, which reads as a filter next to `filter_alt`.
 *   - `strikethrough_s`: the canonical Material strikethrough (its `format_strikethrough` alias
 *     does not exist at this path).
 *
 * Consumed by `index.ts` (the toolbar buttons + every dropdown-anchor chevron). `as const` so each
 * icon is a literal type and a typo'd `ICONS.xxx` access is a COMPILE error, not a runtime
 * undefined-in-innerHTML.
 */

export const ICONS = {
	undo:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M288-192v-72h288q50 0 85-35t35-85q0-50-35-85t-85-35H330l93 93-51 51-180-180 180-180 51 51-93 93h246q80 0 136 56t56 136q0 80-56 136t-136 56H288Z"/></svg>',
	redo:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M384-192q-80 0-136-56t-56-136q0-80 56-136t136-56h246l-93-93 51-51 180 180-180 180-51-51 93-93H384q-50 0-85 35t-35 85q0 50 35 85t85 35h288v72H384Z"/></svg>',
	print:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M648-624v-120H312v120h-72v-192h480v192h-72Zm-480 72h625-625Zm539.79 96q15.21 0 25.71-10.29t10.5-25.5q0-15.21-10.29-25.71t-25.5-10.5q-15.21 0-25.71 10.29t-10.5 25.5q0 15.21 10.29 25.71t25.5 10.5ZM648-216v-144H312v144h336Zm72 72H240v-144H96v-240q0-40 28-68t68-28h576q40 0 68 28t28 68v240H720v144Zm73-216v-153.67Q793-530 781-541t-28-11H206q-16.15 0-27.07 11.04Q168-529.92 168-513.6V-360h72v-72h480v72h73Z"/></svg>',
	format_paint:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M456-96q-29.7 0-50.85-21.15Q384-138.3 384-168v-167H264q-29.7 0-50.85-21.15Q192-377.3 192-407v-265q0-61 42-102.5T336-816h432v409q0 29.7-21.5 50.85Q725-335 696-335H576v167q0 29.7-21.5 50.85Q533-96 504-96h-48ZM264-552h432v-192h-48v144h-72v-144h-48v73h-72v-73H336q-29.7 0-50.85 20.5Q264-703 264-672v120Zm0 145h432v-73H264v73Zm0 0v-73 73Z"/></svg>',
	attach_money:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M444-144v-80q-51-11-87.5-46T305-357l74-30q8 36 40.5 64.5T487-294q39 0 64-20t25-52q0-30-22.5-50T474-456q-78-28-114-61.5T324-604q0-50 32.5-86t87.5-47v-79h72v79q72 12 96.5 55t25.5 45l-70 29q-8-26-32-43t-53-17q-35 0-58 18t-23 44q0 26 25 44.5t93 41.5q70 23 102 60t32 94q0 57-37 96t-101 49v77h-72Z"/></svg>',
	percent:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M311.8-528q-49.8 0-84.8-35.2t-35-85q0-49.8 35.2-84.8t85-35q49.8 0 84.8 35.2t35 85q0 49.8-35.2 84.8t-85 35Zm.2-72q20 0 34-14t14-34q0-20-14-34t-34-14q-20 0-34 14t-14 34q0 20 14 34t34 14Zm335.8 408q-49.8 0-84.8-35.2t-35-85q0-49.8 35.2-84.8t85-35q49.8 0 84.8 35.2t35 85q0 49.8-35.2 84.8t-85 35Zm.2-72q20 0 34-14t14-34q0-20-14-34t-34-14q-20 0-34 14t-14 34q0 20 14 34t34 14Zm-405 72-51-51 525-525 51 51-525 525Z"/></svg>',
	decimal_decrease:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M624-96 480-240l144-144 51 51-57 57h246v72H618l57 57-51 51ZM96-432v-96h96v96H96Zm299.78 0q-54.78 0-93.28-38.66Q264-509.31 264-564v-168q0-54.69 38.72-93.34Q341.44-864 396.22-864t93.28 38.66Q528-786.69 528-732v168q0 54.69-38.72 93.34Q450.56-432 395.78-432Zm.22-72q25 0 42.5-17.5T456-564v-168q0-25-17.5-42.5T396-792q-25 0-42.5 17.5T336-732v168q0 25 17.5 42.5T396-504Z"/></svg>',
	decimal_increase:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="m720-96-51-51 57-57H480v-72h246l-57-57 51-51 144 144L720-96ZM96-432v-96h96v96H96Zm299.78 0q-54.78 0-93.28-38.66Q264-509.31 264-564v-168q0-54.69 38.72-93.34Q341.44-864 396.22-864t93.28 38.66Q528-786.69 528-732v168q0 54.69-38.72 93.34Q450.56-432 395.78-432Zm336 0q-54.78 0-93.28-38.66Q600-509.31 600-564v-168q0-54.69 38.72-93.34Q677.44-864 732.22-864t93.28 38.66Q864-786.69 864-732v168q0 54.69-38.72 93.34Q786.56-432 731.78-432ZM396-504q25 0 42.5-17.5T456-564v-168q0-25-17.5-42.5T396-792q-25 0-42.5 17.5T336-732v168q0 25 17.5 42.5T396-504Zm336 0q25 0 42.5-17.5T792-564v-168q0-25-17.5-42.5T732-792q-25 0-42.5 17.5T672-732v168q0 25 17.5 42.5T732-504Z"/></svg>',
	format_bold:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M266-192v-576h227.95q67.05 0 123.55 41.32Q674-685.35 674-612q0 51-22.5 79.5T609-490.96Q635-479 665-448t30 91q0 91-67.03 128t-125.81 37H266Zm127-118h104.68Q546-310 556-334.5t10-35.5q0-11-10.5-35.5T494-430H393v120Zm0-232h93q33 0 48.5-17.5T550-597q0-24-17.11-39t-44.28-15H393v109Z"/></svg>',
	format_italic:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M216-192v-96h160l124-384H336v-96h408v96H596L472-288h152v96H216Z"/></svg>',
	format_underlined:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M240-144v-72h480v72H240Zm240-144q-96 0-148.5-59.4T279-504.86V-816h97.21v317.09q0 52.85 26.43 85.88Q429.07-380 480.03-380q50.97 0 77.39-33.03 26.41-33.03 26.41-85.88V-816H681v311.14q0 98.06-52.5 157.46Q576-288 480-288Z"/></svg>',
	strikethrough_s:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M486-196q-72 0-126-42t-72-111l81-33q16 51 46.5 77t72.5 26q45 0 71.5-21.5T586-358q0-16-6-29.5T562-412h103q5 11 6.5 23.5T673-359q0 72-52 117.5T486-196ZM96-484v-72h768v72H96Zm384-288q64 0 106 27t68 86l-78 34q-11-30-36.5-48.5T482-692q-37 0-61.5 18T394-628h-87q2-63 51-103.5T480-772Z"/></svg>',
	format_color_text:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M96 0v-192h768V0H96Zm161-336 180-480h86l180 480h-83l-43-123H384l-44 123h-83Zm151-192h144l-70-194h-4l-70 194Z"/></svg>',
	format_color_fill:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="m216-909 51-51 338 338q20 20 19.5 47T605-529L431-355q-20 20-47 20t-47-20L163-530q-19-19-20-46t20-47l170-169-117-117Zm168 168L219-576h1-1 330L384-741Zm348 453q-35 0-59.5-24.5T648-372q0-20 10.5-42.5T692-469q8-11 18.5-24t21.5-26q10 13 20.5 25.5T772-469q16 23 30 47t14 50q0 35-24.5 59.5T732-288ZM96 0v-192h768V0H96Z"/></svg>',
	border_all:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M144-144v-672h672v672H144Zm600-72v-228H516v228h228Zm0-528H516v228h228v-228Zm-528 0v228h228v-228H216Zm0 528h228v-228H216v228Z"/></svg>',
	cell_merge:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M144-144v-240h72v168h168v72H144Zm432 0v-72h168v-168h72v240H576ZM288-336l-51-51 57-57H96v-72h198l-57-57 51-51 144 144-144 144Zm384 0L528-480l144-144 51 51-57 57h198v72H666l57 57-51 51ZM144-576v-240h240v72H216v168h-72Zm600 0v-168H576v-72h240v240h-72Z"/></svg>',
	format_align_left:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M144-144v-72h672v72H144Zm0-150v-72h480v72H144Zm0-150v-72h672v72H144Zm0-150v-72h480v72H144Zm0-150v-72h672v72H144Z"/></svg>',
	format_align_center:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M144-144v-72h672v72H144Zm144-150v-72h384v72H288ZM144-444v-72h672v72H144Zm144-150v-72h384v72H288ZM144-744v-72h672v72H144Z"/></svg>',
	format_align_right:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M144-744v-72h672v72H144Zm192 150v-72h480v72H336ZM144-444v-72h672v72H144Zm192 150v-72h480v72H336ZM144-144v-72h672v72H144Z"/></svg>',
	vertical_align_bottom:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M192-144v-72h576v72H192Zm288-144L288-480l51-51 105 105v-390h72v390l105-105 51 51-192 192Z"/></svg>',
	wrap_text:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M570-192 432-330l138-138 51 51-52 51h103q29.83 0 50.91-21.12 21.09-21.12 21.09-51T722.91-489q-21.08-21-50.91-21H192v-72h480q60.48 0 102.24 41.76T816-438q0 60.48-41.76 102.24T672-294H570l51 51-51 51ZM192-294v-72h192v72H192Zm0-432v-72h576v72H192Z"/></svg>',
	splitscreen:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M216-528q-33 0-52.5-19.5T144-600v-144q0-33 19.5-52.5T216-816h528q33 0 52.5 19.5T816-744v144q0 33-19.5 52.5T744-528H216Zm0-72h528v-144H216v144Zm0 456q-33 0-52.5-19.5T144-216v-144q0-33 19.5-52.5T216-432h528q33 0 52.5 19.5T816-360v144q0 33-19.5 52.5T744-144H216Zm0-72h528v-144H216v144Zm0-384v-144 144Zm0 384v-144 144Z"/></svg>',
	add_row_below:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M216-540h528v-228H216v228Zm-72 372v-672h672v672H672V-240.49h72V-468H216v228h72v72H144Zm336-300Zm0-72v72-72Zm0 0ZM444-84v-84h-84v-72h84v-84h72v84h84v72h-84v84h-72Z"/></svg>',
	delete:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M312-144q-29.7 0-50.85-21.15Q240-186.3 240-216v-480h-48v-72h192v-48h192v48h192v72h-48v479.57Q720-186 698.85-165T648-144H312Zm336-552H312v480h336v-480ZM384-288h72v-336h-72v336Zm120 0h72v-336h-72v336ZM312-696v480-480Z"/></svg>',
	functions:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M288-192v-86l206-202-206-202v-86h384v96H424l192 192-192 192h248v96H288Z"/></svg>',
	filter_alt:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M456.18-192Q446-192 439-198.9t-7-17.1v-227L197-729q-9-12-2.74-25.5Q200.51-768 216-768h528q15.49 0 21.74 13.5Q772-741 763-729L528-443v227q0 10.2-6.88 17.1-6.89 6.9-17.06 6.9h-47.88ZM480-498l162-198H317l163 198Zm0 0Z"/></svg>',
	swap_vert:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M324-432v-294L219-621l-51-51 192-192 192 192-51 51-105-105v294h-72ZM600-96 408-288l51-51 105 105v-294h72v294l105-105 51 51L600-96Z"/></svg>',
	search:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M765-144 526-383q-30 22-65.79 34.5-35.79 12.5-76.18 12.5Q284-336 214-406t-70-170q0-100 70-170t170-70q100 0 170 70t70 170.03q0 40.39-12.5 76.18Q599-464 577-434l239 239-51 51ZM384-408q70 0 119-49t49-119q0-70-49-119t-119-49q-70 0-119 49t-49 119q0 70 49 119t119 49Z"/></svg>',
	arrow_drop_down:
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-384 288-576h384L480-384Z"/></svg>',
} as const;
