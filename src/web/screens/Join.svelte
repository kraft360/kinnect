<script lang="ts">
	import { onMount } from "svelte";
	import type { InvitePreview } from "../../shared/types.ts";
	import { checkText, LIMITS } from "../../shared/validation.ts";
	import { api, errorMessage } from "../api.ts";
	import { defaultDeviceName, inAppBrowser } from "../device.ts";
	import { replaceRoute } from "../router.svelte.ts";
	import { loadSession, session } from "../session.svelte.ts";

	type Mode = "link" | "code" | "recover";
	let { mode, orgId = "", token = "" }: { mode: Mode; orgId?: string; token?: string } = $props();

	let code = $state("");
	let preview = $state<InvitePreview | null>(null);
	let deviceName = $state(defaultDeviceName());
	let error = $state("");
	let busy = $state(false);
	const embedded = inAppBrowser();

	onMount(() => {
		if (mode === "link") lookUp();
	});

	async function lookUp(event?: SubmitEvent) {
		event?.preventDefault();
		error = "";
		busy = true;
		try {
			preview =
				mode === "link"
					? await api<InvitePreview>("POST", "/api/join/preview", { orgId, token })
					: await api<InvitePreview>("POST", "/api/join-code/preview", { code });
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	async function join(event: SubmitEvent) {
		event.preventDefault();
		error = checkText("Device name", deviceName, LIMITS.deviceName) ?? "";
		if (error) return;
		busy = true;
		try {
			if (mode === "link") await api("POST", "/api/join", { orgId, token, deviceName });
			else if (mode === "code") await api("POST", "/api/join-code", { code, deviceName });
			else await api("POST", "/api/recover", { link: token, deviceName });
			await loadSession();
			replaceRoute("setup");
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	async function copyLink() {
		await navigator.clipboard.writeText(location.href);
		error = "Link copied. Now open Chrome (or Safari on iPhone) and paste it into the address bar.";
	}
</script>

<div class="hero">
	<img src="/icon-192.png" alt="" width="64" height="64" />
	<h2>{mode === "recover" ? "Recover owner access" : "Join your family"}</h2>
</div>

{#if session.current.status === "signedIn"}
	<div class="callout warn">
		<p class="body">
			This device is signed in as {session.current.me.member.displayName}. Continuing will sign it
			in as someone else.
		</p>
	</div>
{/if}

{#if embedded}
	<div class="card">
		<p><strong>Open this link in your browser.</strong></p>
		<p>You're viewing it inside {embedded}, where Kinnect can't send you notifications.</p>
		<ol class="steps">
			<li>Tap the ⋮ or share menu.</li>
			<li>
				Choose <strong>Open in Chrome</strong> (or <strong>Open in Safari</strong> on iPhone).
			</li>
		</ol>
		<button class="secondary" onclick={copyLink}>Copy link instead</button>
		{#if error}<p class="muted">{error}</p>{/if}
	</div>
{:else if mode === "code" && !preview}
	<form class="card" onsubmit={lookUp}>
		<label>
			Join code
			<input
				class="code"
				bind:value={code}
				autocapitalize="characters"
				autocomplete="off"
				placeholder="K7M-42Q"
				maxlength="9"
			/>
		</label>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<button type="submit" class="block" disabled={busy || !code.trim()}
			>{busy ? "Checking…" : "Continue"}</button
		>
	</form>
{:else if mode === "recover" || preview}
	<form class="card" onsubmit={join}>
		{#if preview}
			<p class="invite">
				Join <strong>{preview.orgName}</strong> as <strong>{preview.displayName}</strong>?
			</p>
		{:else}
			<p>This signs this device in as the owner of the family.</p>
		{/if}
		<label>This device <input bind:value={deviceName} maxlength={LIMITS.deviceName} /></label>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<button type="submit" class="block" disabled={busy}
			>{busy ? "Joining…" : preview ? `Join as ${preview.displayName}` : "Sign in as owner"}</button
		>
	</form>
{:else if busy}
	<p class="muted">Checking your invite…</p>
{:else}
	<div class="card">
		<p class="error" role="alert">{error}</p>
	</div>
{/if}

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
	.steps {
		padding-left: 1.3em;
	}
	.code {
		font:
			700 1.4rem ui-monospace,
			"SF Mono",
			Menlo,
			Consolas,
			monospace;
		letter-spacing: 0.15em;
		text-align: center;
		text-transform: uppercase;
	}
	.invite {
		font-size: 1.1rem;
	}
</style>
