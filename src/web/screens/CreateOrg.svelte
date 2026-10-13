<script lang="ts">
	import type { CreateOrgRequest } from "../../shared/types.ts";
	import { checkText, checkUsername, LIMITS } from "../../shared/validation.ts";
	import { api, errorMessage } from "../api.ts";
	import { defaultDeviceName } from "../device.ts";
	import { replaceRoute } from "../router.svelte.ts";
	import { loadSession } from "../session.svelte.ts";

	let { link }: { link: string } = $props();

	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const zones = Intl.supportedValuesOf("timeZone");

	let orgName = $state("");
	let timezone = $state(zones.includes(browserZone) ? browserZone : "Asia/Kolkata");
	let displayName = $state("");
	let username = $state("");
	let deviceName = $state(defaultDeviceName());
	let error = $state("");
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error =
			checkText("Family name", orgName, LIMITS.orgName) ??
			checkText("Your name", displayName, LIMITS.displayName) ??
			checkUsername(username.trim()) ??
			checkText("Device name", deviceName, LIMITS.deviceName) ??
			"";
		if (error) return;
		busy = true;
		try {
			await api("POST", "/api/create-org", {
				link,
				orgName,
				timezone,
				username: username.trim(),
				displayName,
				deviceName,
			} satisfies CreateOrgRequest);
			await loadSession();
			replaceRoute("setup");
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="hero">
	<img src="/icon-192.png" alt="" width="64" height="64" />
	<h2>Create your family</h2>
	<p class="muted">You'll be the owner: you can add family members and send them invite links.</p>
</div>

<form class="card" onsubmit={submit}>
	<label
		>Family name <input
			bind:value={orgName}
			maxlength={LIMITS.orgName}
			placeholder="e.g. Sharma family"
		/></label
	>
	<label>
		Timezone
		<select bind:value={timezone}>
			{#each zones as zone (zone)}<option value={zone}>{zone}</option>{/each}
		</select>
	</label>
	<label
		>Your name <input
			bind:value={displayName}
			maxlength={LIMITS.displayName}
			placeholder="As your family will see it"
		/></label
	>
	<label
		>Username <input
			bind:value={username}
			autocapitalize="none"
			autocomplete="off"
			placeholder="e.g. anil"
		/></label
	>
	<label>This device <input bind:value={deviceName} maxlength={LIMITS.deviceName} /></label>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<button type="submit" class="block" disabled={busy}>{busy ? "Creating…" : "Create family"}</button
	>
</form>

<style>
	.hero {
		text-align: center;
		padding: 16px 8px;
	}
	.hero img {
		border-radius: 16px;
		box-shadow: var(--shadow-raised);
		margin-bottom: 12px;
	}
	.hero h2 {
		margin-bottom: 6px;
	}
</style>
