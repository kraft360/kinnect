<script lang="ts">
	import type { CreateMemberRequest, Member, MeResponse, Team } from "../../shared/types.ts";
	import { checkText, checkUsername, LIMITS } from "../../shared/validation.ts";
	import { api, errorMessage } from "../api.ts";
	import { href } from "../router.svelte.ts";
	import { loadSession, signOut } from "../session.svelte.ts";
	import Avatar from "../components/Avatar.svelte";
	import Icon from "../components/Icon.svelte";
	import PageHeader from "../components/PageHeader.svelte";
	import DeviceList from "./DeviceList.svelte";
	import { setupStatus, setupSteps } from "../setup.svelte.ts";

	let { me }: { me: MeResponse } = $props();

	const admin = $derived(me.member.role === "owner" || me.member.role === "admin");
	const roleLabel = { owner: "Owner", admin: "Admin", member: "Member" };
	const phoneStatus = $derived(setupStatus(me));
	const stepsLeft = $derived(setupSteps(me).filter((s) => !s.done).length);

	let members = $state<Member[] | null>(null);
	let error = $state("");
	let adding = $state(false);
	let newMember = $state<CreateMemberRequest>({ username: "", displayName: "", role: "member" });
	let addError = $state("");
	let teams = $state<Team[] | null>(null);
	let addingTeam = $state(false);
	let teamName = $state("");
	let teamError = $state("");

	async function loadMembers() {
		try {
			members = await api<Member[]>("GET", "/api/members");
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function addMember(event: SubmitEvent) {
		event.preventDefault();
		addError =
			checkText("Name", newMember.displayName, LIMITS.displayName) ??
			checkUsername(newMember.username.trim()) ??
			"";
		if (addError) return;
		try {
			const created = await api<Member>("POST", "/api/members", {
				...newMember,
				username: newMember.username.trim(),
			});
			location.hash = href("member", created.id);
		} catch (e) {
			addError = errorMessage(e);
		}
	}

	async function loadTeams() {
		try {
			teams = await api<Team[]>("GET", "/api/teams");
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function addTeam(event: SubmitEvent) {
		event.preventDefault();
		teamError = checkText("Household name", teamName, LIMITS.teamName) ?? "";
		if (teamError) return;
		try {
			const created = await api<Team>("POST", "/api/teams", { name: teamName });
			location.hash = href("team", created.id);
		} catch (e) {
			teamError = errorMessage(e);
		}
	}

	// Family settings (admins): schedules use the timezone; the default time fills in dates without a time (FR-24).
	// svelte-ignore state_referenced_locally (edited copies of the current settings)
	let family = $state({
		timezone: me.organization.timezone,
		defaultDueTime: me.organization.defaultDueTime,
	});
	let familyMessage = $state("");
	const zones = Intl.supportedValuesOf("timeZone");

	async function saveFamily(event: SubmitEvent) {
		event.preventDefault();
		if (
			family.timezone !== me.organization.timezone &&
			!confirm("Change the family's timezone? Upcoming reminders will follow the new timezone.")
		)
			return;
		try {
			await api("PATCH", "/api/organization", family);
			familyMessage = "Saved.";
			await loadSession();
		} catch (e) {
			familyMessage = errorMessage(e);
		}
	}

	async function setSimpleView(on: boolean) {
		if (
			on &&
			!confirm(
				"Switch to simple view? This phone will show only today's tasks, with large text. You can switch back from the bottom of that screen.",
			)
		)
			return;
		try {
			await api("PATCH", "/api/me", { simpleView: on });
			await loadSession();
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function confirmSignOut() {
		if (
			!confirm(
				"Sign out of Kinnect on this device? You'll need a new add-device link to sign in again.",
			)
		)
			return;
		try {
			await signOut();
		} catch (e) {
			error = errorMessage(e);
		}
	}

	$effect(() => {
		loadTeams();
		if (admin) loadMembers();
	});

	const adminCount = $derived(members?.filter((m) => m.role !== "member").length ?? 0);
</script>

<PageHeader title="Settings" />

<h3 class="section-label">You</h3>
<section class="card profile">
	<Avatar id={me.member.id} name={me.member.displayName} size={56} />
	<div>
		<p class="name">{me.member.displayName}</p>
		<p class="muted small">@{me.member.username} · {roleLabel[me.member.role]}</p>
	</div>
</section>

<a class="card row-link phone" href={href("setup")}>
	<span class="phone-icon {phoneStatus}"
		><Icon name={phoneStatus === "broken" ? "bell-off" : "phone"} size={20} /></span
	>
	<span class="who">
		<strong>This phone</strong>
		<span class="small {phoneStatus === 'broken' ? 'error' : 'muted'}">
			{phoneStatus === "broken"
				? "Reminders aren't reaching this phone"
				: stepsLeft
					? `${stepsLeft} setup step${stepsLeft > 1 ? "s" : ""} left`
					: "Set up for reminders"}
		</span>
	</span>
	<span class="chevron"><Icon name="chevron" size={18} /></span>
</a>

<section class="card">
	<div class="split">
		<div>
			<h3>Simple view</h3>
			<p class="muted small">Only today's tasks, with large text and big Done buttons.</p>
		</div>
		<button class="secondary small" onclick={() => setSimpleView(true)}>Switch</button>
	</div>
</section>

<section class="card">
	<h3>Your devices</h3>
	<DeviceList memberId={me.member.id} currentDeviceId={me.device.id} />
	<button class="ghost small danger sign-out" onclick={confirmSignOut}
		><Icon name="logout" size={18} />Sign out of this device</button
	>
</section>

{#if error}<p class="error">{error}</p>{/if}

<h3 class="section-label">{me.organization.name}</h3>

{#if admin && members && adminCount < 2}
	<div class="callout warn">
		<Icon name="warning" />
		<p class="body">
			<strong>Appoint a second admin.</strong> If you lose your phone, another admin can send you a new
			link. Open a member below and make them an admin.
		</p>
	</div>
{/if}

{#if admin}
	<section class="card">
		<h3>Family members</h3>
		{#if members === null}
			<p class="muted">Loading…</p>
		{:else}
			<ul class="list">
				{#each members as member (member.id)}
					<li>
						<a class="row-link" href={href("member", member.id)}>
							<Avatar id={member.id} name={member.displayName} size={36} />
							<span class="who">
								<strong>{member.displayName}</strong>
								<span class="muted small">
									{roleLabel[member.role]} · {member.activeDevices
										? `${member.activeDevices} device${member.activeDevices > 1 ? "s" : ""}`
										: "not joined yet"}
								</span>
							</span>
						</a>
						<span class="chevron"><Icon name="chevron" size={18} /></span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if adding}
			<form class="sub-form" onsubmit={addMember}>
				<h3>New member</h3>
				<label
					>Name <input
						bind:value={newMember.displayName}
						maxlength={LIMITS.displayName}
						placeholder="e.g. Dad"
					/></label
				>
				<label
					>Username <input
						bind:value={newMember.username}
						autocapitalize="none"
						autocomplete="off"
						placeholder="e.g. dad"
					/></label
				>
				<label>
					Role
					<select bind:value={newMember.role}>
						<option value="member">Member</option>
						<option value="admin">Admin</option>
					</select>
				</label>
				{#if addError}<p class="error" role="alert">{addError}</p>{/if}
				<div class="actions">
					<button type="submit">Add member</button>
					<button type="button" class="ghost" onclick={() => (adding = false)}>Cancel</button>
				</div>
			</form>
		{:else}
			<button class="ghost small add" onclick={() => (adding = true)}
				><Icon name="plus" size={18} />Add a member</button
			>
		{/if}
	</section>
{/if}

<section class="card">
	<h3>{admin ? "Households" : "Your households"}</h3>
	{#if teams === null}
		<p class="muted">Loading…</p>
	{:else if teams.length === 0}
		<p class="muted small">
			{admin
				? "No households yet. A household groups the people who live together, for things like a shared shopping list."
				: "You're not in a household yet. An admin can add you to one."}
		</p>
	{:else}
		<ul class="list">
			{#each teams as team (team.id)}
				<li>
					<a class="row-link" href={href("team", team.id)}>
						<span class="house"><Icon name="home" size={20} /></span>
						<span class="who">
							<strong>{team.name}</strong>
							<span class="muted small"
								>{team.memberIds.length} {team.memberIds.length === 1 ? "person" : "people"}</span
							>
						</span>
					</a>
					<span class="chevron"><Icon name="chevron" size={18} /></span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if admin}
		{#if addingTeam}
			<form class="sub-form" onsubmit={addTeam}>
				<label
					>Household name <input
						bind:value={teamName}
						maxlength={LIMITS.teamName}
						placeholder="e.g. Bengaluru home"
					/></label
				>
				{#if teamError}<p class="error" role="alert">{teamError}</p>{/if}
				<div class="actions">
					<button type="submit">Create household</button>
					<button type="button" class="ghost" onclick={() => (addingTeam = false)}>Cancel</button>
				</div>
			</form>
		{:else}
			<button class="ghost small add" onclick={() => (addingTeam = true)}
				><Icon name="plus" size={18} />Add a household</button
			>
		{/if}
	{/if}
</section>

{#if admin}
	<section class="card">
		<h3>Family settings</h3>
		<form onsubmit={saveFamily}>
			<label>
				Timezone
				<select bind:value={family.timezone}>
					{#each zones as zone (zone)}<option value={zone}>{zone}</option>{/each}
				</select>
			</label>
			<label
				>Default time for tasks with only a date <input
					type="time"
					bind:value={family.defaultDueTime}
					required
				/></label
			>
			{#if familyMessage}<p class="muted" role="status">{familyMessage}</p>{/if}
			<button type="submit" class="small">Save</button>
		</form>
	</section>
	<section class="card">
		<h3>Family data</h3>
		<p class="muted small">
			A copy of everything: tasks, their history, members and households. Sign-in details are not
			included. Keep one somewhere safe now and then.
		</p>
		<a class="button secondary small" href="/api/export" download
			><Icon name="download" size={18} />Download family data</a
		>
	</section>
{:else}
	<p class="muted small center">Timezone: {me.organization.timezone}</p>
{/if}

<style>
	.profile {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.profile p {
		margin: 0;
	}
	.name {
		font-size: 1.2rem;
		font-weight: 700;
	}
	.split {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.split p {
		margin: 0;
	}
	.split h3 {
		margin-bottom: 2px;
	}
	.who {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.house {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--on-accent-soft);
		flex: none;
	}
	.chevron {
		display: flex;
		color: var(--muted);
		opacity: 0.6;
	}
	.add,
	.sign-out {
		margin: 4px 0 -4px -12px;
	}
	.sub-form {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.center {
		text-align: center;
	}
	.phone {
		gap: 14px;
	}
	.phone .who {
		flex: 1;
	}
	.phone-icon {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		flex: none;
		background: var(--accent-soft);
		color: var(--on-accent-soft);
	}
	.phone-icon.incomplete {
		background: var(--warn-soft);
		color: var(--warn);
	}
	.phone-icon.broken {
		background: var(--danger-soft);
		color: var(--danger);
	}
</style>
