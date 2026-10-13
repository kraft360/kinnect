<script lang="ts">
	import type { IssuedInvite, Member, MeResponse, Team } from "../../shared/types.ts";
	import { api, errorMessage } from "../api.ts";
	import { href } from "../router.svelte.ts";
	import { notificationText } from "../sync.svelte.ts";
	import Avatar from "../components/Avatar.svelte";
	import Icon from "../components/Icon.svelte";
	import PageHeader from "../components/PageHeader.svelte";
	import DeviceList from "./DeviceList.svelte";

	let { me, memberId }: { me: MeResponse; memberId: string } = $props();

	const admin = $derived(me.member.role === "owner" || me.member.role === "admin");
	let member = $state<Member | null>(null);
	let invite = $state<IssuedInvite | null>(null);
	let error = $state("");
	let notice = $state("");
	let teams = $state<Team[]>([]);

	async function load() {
		try {
			const [all, allTeams] = await Promise.all([
				api<Member[]>("GET", "/api/members"),
				api<Team[]>("GET", "/api/teams"),
			]);
			member = all.find((m) => m.id === memberId) ?? null;
			teams = allTeams.filter((t) => t.memberIds.includes(memberId));
			if (!member) error = "Member not found.";
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function update(change: { role?: "admin" | "member"; simpleView?: boolean }) {
		try {
			member = await api<Member>("PATCH", `/api/members/${memberId}`, change);
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function createInvite() {
		error = notice = "";
		try {
			const kind = member?.activeDevices ? "add_device" : "invite";
			invite = await api<IssuedInvite>("POST", `/api/members/${memberId}/invites`, { kind });
		} catch (e) {
			error = errorMessage(e);
		}
	}

	const message = $derived(
		invite && member
			? `${member.displayName}, join our family on Kinnect: ${invite.url}\n\nOn iPhone, after adding Kinnect to your Home Screen, enter this code instead: ${invite.code}\n\nThe link works once and expires ${new Date(invite.expiresAt).toLocaleString()}.`
			: "",
	);

	async function copy() {
		await navigator.clipboard.writeText(message);
		notice = "Copied. Paste it into your family chat.";
	}

	async function share() {
		try {
			await navigator.share({ text: message });
		} catch {
			// Cancelled by the user.
		}
	}

	$effect(() => {
		memberId;
		load();
	});
</script>

{#if !member}
	<PageHeader title="Member" back={{ href: href("settings"), label: "Settings" }} />
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}

{#if member}
	<p class="back-row"><a href={href("settings")}><Icon name="back" size={20} />Settings</a></p>
	<div class="hero">
		<Avatar id={member.id} name={member.displayName} size={64} />
		<div>
			<h2>{member.displayName}</h2>
			<p class="muted">
				@{member.username} · {member.role === "owner"
					? "Owner"
					: member.role === "admin"
						? "Admin"
						: "Member"}
			</p>
			<p class="small">
				<span class="status-dot {member.notifications}"></span>{notificationText(
					member.notifications,
					member.unconfirmedSince,
				)}
			</p>
		</div>
	</div>

	{#if admin}
		<section class="card">
			<h3>{member.activeDevices ? "Add a device" : "Invite"}</h3>
			{#if invite}
				<p class="small">
					Send this to {member.displayName}. It works once and expires {new Date(
						invite.expiresAt,
					).toLocaleString()}.
				</p>
				<div class="code-box">
					<span class="muted small">Join code</span>
					<span class="code">{invite.code}</span>
				</div>
				<p class="link muted">{invite.url}</p>
				<div class="actions">
					{#if "share" in navigator}<button onclick={share}
							><Icon name="send" size={18} />Share…</button
						>{/if}
					<button class="secondary" onclick={copy}>Copy message</button>
				</div>
				{#if notice}<p class="muted small" role="status">{notice}</p>{/if}
			{:else}
				<p class="muted small">
					{member.activeDevices
						? "Create a link to sign in a new or replacement device."
						: "Create a personal link that signs their phone in. Any earlier link stops working."}
				</p>
				<button onclick={createInvite}
					>{member.activeDevices ? "Create add-device link" : "Create invite link"}</button
				>
			{/if}
		</section>

		<section class="card">
			<h3>Role</h3>
			{#if member.role === "owner"}
				<p class="muted">Owner of the family</p>
			{:else}
				<select
					value={member.role}
					onchange={(e) => update({ role: e.currentTarget.value as "admin" | "member" })}
					aria-label="Role"
				>
					<option value="member">Member: completes and edits tasks</option>
					<option value="admin">Admin: also manages members and devices</option>
				</select>
			{/if}
		</section>

		<section class="card">
			<label class="check">
				<input
					type="checkbox"
					checked={member.simpleView}
					onchange={(e) => update({ simpleView: e.currentTarget.checked })}
				/>
				<span>
					<strong>Simple view</strong><br />
					<span class="muted small"
						>Only today's tasks, with large text and Done buttons. Their phone switches straight
						away.</span
					>
				</span>
			</label>
		</section>

		<section class="card">
			<h3>Households</h3>
			{#if teams.length}
				<ul class="list">
					{#each teams as team (team.id)}
						<li>
							<a class="row-link" href={href("team", team.id)}
								><Icon name="home" size={20} />{team.name}</a
							>
							<Icon name="chevron" size={18} />
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted small">Not in any household. Open a household in Settings to add them.</p>
			{/if}
		</section>
	{/if}

	{#if admin || member.id === me.member.id}
		<section class="card">
			<h3>Devices</h3>
			<DeviceList memberId={member.id} currentDeviceId={me.device.id} />
		</section>
	{/if}
{/if}

<style>
	.back-row a {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		min-height: 40px;
		margin-left: -6px;
		font-size: 0.95rem;
	}
	.hero {
		display: flex;
		align-items: center;
		gap: 16px;
		margin: 4px 0 20px;
	}
	.hero p {
		margin: 2px 0 0;
	}
	.code-box {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 14px;
		margin: 8px 0;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}
	.code {
		font:
			700 1.8rem/1.2 ui-monospace,
			"SF Mono",
			Menlo,
			Consolas,
			monospace;
		letter-spacing: 0.12em;
	}
	.link {
		word-break: break-all;
		font-size: 0.8rem;
	}
	.check {
		align-items: flex-start;
	}
	.check input {
		margin-top: 2px;
	}
</style>
