<script lang="ts">
	import Icon from "../components/Icon.svelte";
	import { live } from "../sync.svelte.ts";
</script>

{#if live.status === "offline"}
	<div class="callout warn" role="status">
		<Icon name="warning" />
		<p class="body">Offline. Changes can't be saved until you're back online.</p>
	</div>
{/if}
{#if live.error}
	<div class="callout danger" role="alert">
		<Icon name="warning" />
		<p class="body">{live.error}</p>
		<button class="ghost small" onclick={() => (live.error = "")}>OK</button>
	</div>
{/if}

<style>
	.callout {
		align-items: center;
	}
	.callout p {
		margin: 0;
	}
</style>
