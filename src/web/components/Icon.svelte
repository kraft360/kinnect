<script lang="ts" module>
	// Inline SVG icons (24×24, stroked), so there's no icon dependency.
	const paths = {
		today:
			'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
		tasks:
			'<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
		settings:
			'<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		back: '<path d="m15 18-6-6 6-6"/>',
		chevron: '<path d="m9 18 6-6-6-6"/>',
		down: '<path d="m6 9 6 6 6-6"/>',
		bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
		"bell-off":
			'<path d="M8.7 3A6 6 0 0 1 18 8c0 2.7.6 4.6 1.3 6M17 17H3s3-2 3-9c0-.7.1-1.3.3-1.9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20"/>',
		warning:
			'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		"check-circle": '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
		people:
			'<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9"/>',
		person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
		eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
		label:
			'<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
		repeat:
			'<path d="m17 2 4 4-4 4"/><path d="M3 11V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
		clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
		note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
		list: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 9 1.5 1.5L11 8M7 15l1.5 1.5L11 14M14 9h3M14 15h3"/>',
		home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
		phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
		archive:
			'<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
		up: '<path d="m18 15-6-6-6 6"/>',
		trash:
			'<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
		logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
		sparkle:
			'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4M5 17v4M3 19h4"/>',
		send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
		download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
	} as const;
	export type IconName = keyof typeof paths;
</script>

<script lang="ts">
	let {
		name,
		size = 22,
		stroke = 2,
	}: { name: IconName; size?: number; stroke?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{@html paths[name]}
</svg>
