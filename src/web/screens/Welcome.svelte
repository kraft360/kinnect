<script lang="ts">
	import { isIos, isStandalone } from "../device.ts";
	import { href } from "../router.svelte.ts";
</script>

<div class="hero">
	<img src="/icon-192.png" alt="" width="88" height="88" />
	<h2>Welcome to Kinnect</h2>
	<p class="muted">
		Your family's shared tasks and reminders: medicines, bills, chores and shopping lists, all in
		one place.
	</p>
</div>

<section class="card">
	<h3>Joining a family?</h3>
	<p class="muted small">
		Open the invite link a family admin sent you, or enter the code from the invite message.
	</p>
	{#if isIos() && isStandalone()}
		<p class="muted small">
			On iPhone, links open in Safari, not in this app, so use the code instead.
		</p>
	{/if}
	<a class="button block" href={href("code")}>Enter a join code</a>
</section>

<style>
	.hero {
		text-align: center;
		padding: 24px 8px 20px;
	}
	.hero img {
		border-radius: 22px;
		box-shadow: var(--shadow-raised);
		margin-bottom: 16px;
	}
	.hero h2 {
		font-size: 1.7rem;
		margin-bottom: 8px;
	}
	.hero p {
		max-width: 26em;
		margin: 0 auto;
	}
	.button {
		margin-top: 8px;
	}
</style>
