<script lang="ts">
	import type { MeResponse } from "../../shared/types.ts";
	import { formatWhen } from "../../shared/time.ts";
	import { api, errorMessage } from "../api.ts";
	import Icon from "../components/Icon.svelte";
	import PageHeader from "../components/PageHeader.svelte";
	import { href } from "../router.svelte.ts";
	import { enableNotifications, session } from "../session.svelte.ts";
	import {
		android,
		install,
		ios,
		notShowing,
		setup,
		setupStatus,
		setupSteps,
		tick,
		type StepId,
	} from "../setup.svelte.ts";

	// "Set up this phone": everything Phase 0 showed a phone needs for reminders to arrive on time.
	// Opened once after joining, and from Settings or Today's warning later.
	let { me }: { me: MeResponse } = $props();

	const steps = $derived(setupSteps(me));
	const status = $derived(setupStatus(me));
	const left = $derived(steps.filter((s) => !s.done).length);
	const done = (id: StepId) => steps.find((s) => s.id === id)?.done ?? false;

	let busy = $state(false);
	let error = $state("");
	let showInstallHelp = $state(false);
	let test = $state<"idle" | "waiting" | "shown" | "missing">("idle");

	async function turnOn() {
		busy = true;
		error = "";
		try {
			setup.permission = await enableNotifications();
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	async function installApp() {
		if (!(await install())) showInstallHelp = true;
	}

	/** Sends a test and waits up to 30 s for this device to report showing it (FR-46). */
	async function sendTest() {
		error = "";
		const before = me.device.lastAckAt;
		try {
			await api("POST", "/api/me/test-notification", {});
		} catch (e) {
			error = errorMessage(e);
			return;
		}
		test = "waiting";
		for (let i = 0; i < 15; i++) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			const fresh = await api<MeResponse>("GET", "/api/me").catch(() => null);
			if (fresh && fresh.device.lastAckAt !== before) {
				session.current = { status: "signedIn", me: fresh };
				test = "shown";
				return;
			}
		}
		test = "missing";
	}

	const titles: Record<StepId, string> = {
		install: "Install Kinnect on your home screen",
		notifications: "Turn on notifications",
		battery: "Let Chrome run in the background",
		test: "Send a test notification",
	};
</script>

<PageHeader title="Set up this phone" back={{ href: href("settings"), label: "Settings" }}>
	{#snippet subtitle()}
		<span class="muted">So reminders arrive on time, even when the phone is locked.</span>
	{/snippet}
</PageHeader>

{#if status === "broken"}
	<div class="callout danger">
		<Icon name="bell-off" />
		<div class="body">
			<p><strong>Reminders aren't reaching this phone</strong></p>
			{#if notShowing(me)}
				<p class="small">
					Notifications sent since {formatWhen(
						me.device.unconfirmedSince!,
						me.organization.timezone,
						Date.now(),
					)} haven't appeared. Check the steps below, then send a test.
				</p>
			{:else}
				<p class="small">Finish the steps below.</p>
			{/if}
		</div>
	</div>
{:else if status === "ok"}
	<div class="callout info all-set">
		<Icon name="check-circle" />
		<div class="body"><p><strong>This phone is all set.</strong></p></div>
	</div>
{:else if setup.permission === "unsupported" && !ios}
	<div class="callout warn">
		<Icon name="warning" />
		<div class="body">
			<p>This browser can't show Kinnect reminders. Use Chrome on Android, or Safari on iPhone.</p>
		</div>
	</div>
{/if}

<ol class="steps">
	{#each steps as step, i (step.id)}
		<li class="card step" class:done={step.done}>
			<span class="marker" aria-hidden="true">
				{#if step.done}<Icon name="check" size={18} stroke={2.6} />{:else}{i + 1}{/if}
			</span>
			<div class="content">
				<h3>{titles[step.id]}<span class="sr">{step.done ? " (done)" : ""}</span></h3>

				{#if step.id === "install"}
					{#if step.done}
						<p class="muted small">
							{setup.installed
								? "You're using the installed app."
								: "Open Kinnect from its home screen icon from now on."}
						</p>
					{:else if ios}
						<p class="small">Notifications on iPhone only work in the installed app.</p>
						<ol class="how">
							<li>Tap the <strong>Share</strong> button in Safari.</li>
							<li>Choose <strong>Add to Home Screen</strong>.</li>
							<li>Open Kinnect from your Home Screen and enter your join code.</li>
						</ol>
					{:else}
						<p class="muted small">It opens like an app and is easier to find.</p>
						{#if showInstallHelp || !setup.installPrompt}
							<p class="small">
								In Chrome, tap <strong>⋮</strong> → <strong>Add to Home screen</strong> (or
								<strong>Install app</strong>).
							</p>
						{/if}
						<div class="actions">
							{#if setup.installPrompt}<button class="small" onclick={installApp}>Install</button
								>{/if}
							<button class="secondary small" onclick={() => tick("install")}
								>I've installed it</button
							>
						</div>
					{/if}
				{:else if step.id === "notifications"}
					{#if step.done}
						<p class="muted small">Notifications are on.</p>
					{:else if ios && !setup.installed}
						<p class="muted small">Available once Kinnect is installed (step 1).</p>
					{:else if setup.permission === "denied"}
						<p class="small">
							Notifications are blocked for Kinnect. Allow them in the browser's site settings (tap
							the icon left of the address), then come back.
						</p>
						{#if android}<p class="small">
								If you installed Kinnect: Android Settings → Apps → <strong>Kinnect</strong> →
								Notifications <strong>on</strong>.
							</p>{/if}
					{:else}
						<button class="small" onclick={turnOn} disabled={busy}
							><Icon name="bell" size={18} />Turn on notifications</button
						>
					{/if}
				{:else if step.id === "battery"}
					<p class="small">
						Android Settings → Apps → <strong>Chrome</strong> → App battery usage →
						<strong>Unrestricted</strong>.
					</p>
					<p class="muted small">
						Without this, Android holds reminders until you unlock the phone. Setting only Kinnect
						isn't enough; it has to be Chrome.
					</p>
					{#if step.done}
						<button class="link" onclick={() => tick("battery", false)}>Not done yet</button>
					{:else}
						<div class="actions">
							<button class="secondary small" onclick={() => tick("battery")}>I've done this</button
							>
						</div>
					{/if}
				{:else if step.id === "test"}
					{#if test === "waiting"}
						<p class="small" role="status">Sent. Waiting for it to appear on this phone…</p>
					{:else if test === "shown"}
						<p class="small ok" role="status">It arrived. Reminders will show up like that.</p>
					{:else if test === "missing"}
						<p class="small" role="status"><strong>It didn't show up.</strong></p>
						<ul class="how">
							{#if android}
								<li>
									If you installed Kinnect: Android Settings → Apps → <strong>Kinnect</strong> →
									Notifications <strong>on</strong>. Installing can switch them off.
								</li>
								<li>Check Chrome's battery setting above.</li>
							{/if}
							<li>Check the phone isn't in Do Not Disturb.</li>
						</ul>
					{:else if step.done}
						<p class="muted small">A notification has appeared on this phone.</p>
					{:else}
						<p class="muted small">Checks that a reminder really appears on this phone.</p>
					{/if}
					{#if test !== "waiting"}
						<div class="actions">
							<button
								class={step.done ? "secondary small" : "small"}
								onclick={sendTest}
								disabled={!done("notifications")}
							>
								<Icon name="send" size={18} />{test === "missing"
									? "Try again"
									: step.done
										? "Send another"
										: "Send a test"}
							</button>
						</div>
					{/if}
				{/if}
			</div>
		</li>
	{/each}
</ol>

{#if error}<p class="error" role="alert">{error}</p>{/if}

<a class="button block {left ? 'secondary' : ''}" href={href("today")}
	>{left ? "Skip for now" : "Go to Today"}</a
>

<style>
	.steps {
		list-style: none;
		margin: 0 0 var(--space);
		padding: 0;
	}
	.step {
		display: flex;
		gap: 14px;
		align-items: flex-start;
	}
	.marker {
		flex: none;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--on-accent-soft);
		font-weight: 700;
	}
	.done .marker {
		background: var(--success);
		color: var(--surface);
	}
	.content {
		flex: 1;
		min-width: 0;
	}
	.content h3 {
		margin: 4px 0 6px;
		font-size: 1.05rem;
	}
	.done h3 {
		color: var(--muted);
	}
	.content p {
		margin: 0 0 8px;
	}
	.how {
		margin: 0 0 8px;
		padding-left: 1.2em;
		font-size: 0.92rem;
	}
	.how li {
		margin-bottom: 4px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.ok {
		color: var(--success);
		font-weight: 600;
	}
	.all-set :global(svg) {
		color: var(--success);
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
