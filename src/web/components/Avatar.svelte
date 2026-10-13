<script lang="ts">
	// A member's initials on a colour derived from their id, so each person is recognisable at a glance.
	let { id, name, size = 32 }: { id: string; name: string; size?: number } = $props();

	const COLOURS = [
		"#0f766e",
		"#1d4ed8",
		"#6d28d9",
		"#be185d",
		"#b45309",
		"#15803d",
		"#0e7490",
		"#4d5562",
	];
	const colour = $derived(
		COLOURS[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % COLOURS.length],
	);
	const initials = $derived(
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((word) => word[0]?.toUpperCase() ?? "")
			.join("") || "?",
	);
</script>

<span
	class="avatar"
	style:background={colour}
	style:width="{size}px"
	style:height="{size}px"
	style:font-size="{size * 0.4}px"
	aria-hidden="true">{initials}</span
>

<style>
	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		border-radius: 50%;
		color: #fff;
		font-weight: 700;
		letter-spacing: 0.02em;
		line-height: 1;
	}
</style>
