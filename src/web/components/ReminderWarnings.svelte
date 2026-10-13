<script lang="ts">
	import Icon from "./Icon.svelte";

	// Who won't get reminders for the tasks on this screen, shown once at the top (FR-42).
	let { warnings }: { warnings: string[] } = $props();
</script>

{#if warnings.length}
	<div class="callout warn" role="status">
		<Icon name="bell-off" />
		<div class="body">
			{#each warnings as warning (warning)}<p class="line"><strong>{warning}</strong></p>{/each}
			<p class="small muted">
				Their reminders won't arrive. They can fix it in Kinnect's Settings.
			</p>
		</div>
	</div>
{/if}

<style>
	.line {
		margin-bottom: 2px;
		font-size: 0.95rem;
	}
</style>
