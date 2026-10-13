<script lang="ts">
	import type { Device } from "../../shared/types.ts";
	import { api, errorMessage } from "../api.ts";
	import Icon from "../components/Icon.svelte";
	import { notificationText } from "../sync.svelte.ts";

	let { memberId, currentDeviceId }: { memberId: string; currentDeviceId?: string } = $props();

	let devices = $state<Device[] | null>(null);
	let error = $state("");

	async function load() {
		try {
			devices = await api<Device[]>("GET", `/api/members/${memberId}/devices`);
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function revoke(device: Device) {
		if (!confirm(`Sign out "${device.name}"? It will need a new add-device link to sign in again.`))
			return;
		try {
			await api("DELETE", `/api/devices/${device.id}`);
			await load();
		} catch (e) {
			error = errorMessage(e);
		}
	}

	const date = (ms: number) =>
		new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

	$effect(() => {
		memberId;
		load();
	});
</script>

{#if error}<p class="error">{error}</p>{/if}
{#if devices === null}
	<p class="muted">Loading devices…</p>
{:else if devices.length === 0}
	<p class="muted small">No devices signed in yet.</p>
{:else}
	<ul class="list">
		{#each devices as device (device.id)}
			<li class:revoked={device.revokedAt}>
				<span class="device">
					<span class="icon"><Icon name="phone" size={20} /></span>
					<span class="text">
						<span>
							<strong>{device.name}</strong>
							{#if device.id === currentDeviceId}<span class="badge accent">This device</span>{/if}
						</span>
						{#if device.revokedAt}
							<span class="muted small">Signed out {date(device.revokedAt)}</span>
						{:else}
							<span class="small">
								<span class="status-dot {device.notifications}"></span>{notificationText(
									device.notifications,
									device.unconfirmedSince,
								)}
							</span>
							<span class="muted small"
								>Signed in {date(device.createdAt)}{device.lastSeen
									? ` · last used ${date(device.lastSeen)}`
									: ""}</span
							>
						{/if}
					</span>
				</span>
				{#if !device.revokedAt && device.id !== currentDeviceId}
					<button class="ghost small danger" onclick={() => revoke(device)}>Sign out</button>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.device {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		min-width: 0;
	}
	.icon {
		display: flex;
		color: var(--muted);
		margin-top: 2px;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.badge {
		margin-left: 4px;
	}
	.revoked {
		opacity: 0.7;
	}
</style>
