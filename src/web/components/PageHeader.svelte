<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	// Title row for a screen: optional back link above, optional action on the right.
	let {
		title,
		back,
		subtitle,
		action,
		done = false,
	}: {
		title: string;
		back?: { href: string; label: string };
		subtitle?: Snippet;
		action?: Snippet;
		done?: boolean;
	} = $props();
</script>

<div class="page-header">
	{#if back}
		<a class="back" href={back.href}><Icon name="back" size={20} />{back.label}</a>
	{/if}
	<div class="row">
		<h2 class:done>{title}</h2>
		{#if action}<div class="action">{@render action()}</div>{/if}
	</div>
	{#if subtitle}<div class="subtitle">{@render subtitle()}</div>{/if}
</div>

<style>
	.page-header {
		margin: 4px 0 var(--space);
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		min-height: 40px;
		margin-left: -6px;
		font-size: 0.95rem;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: var(--tap);
	}
	h2 {
		overflow-wrap: anywhere;
	}
	.done {
		text-decoration: line-through;
		color: var(--muted);
	}
	.action {
		flex: none;
	}
	.subtitle {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		color: var(--muted);
		font-size: 0.95rem;
	}
</style>
