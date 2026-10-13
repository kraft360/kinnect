<script lang="ts">
	import type {
		Member,
		MeResponse,
		RemovalPreview,
		Team,
		TeamDeletePreview,
	} from "../../shared/types.ts";
	import { checkText, LIMITS } from "../../shared/validation.ts";
	import { api, errorMessage } from "../api.ts";
	import Avatar from "../components/Avatar.svelte";
	import Icon from "../components/Icon.svelte";
	import PageHeader from "../components/PageHeader.svelte";
	import { href } from "../router.svelte.ts";

	let { me, teamId }: { me: MeResponse; teamId: string } = $props();

	const admin = $derived(me.member.role === "owner" || me.member.role === "admin");
	let team = $state<Team | null>(null);
	let members = $state<Member[]>([]);
	let error = $state("");
	let name = $state("");
	let renaming = $state(false);
	let addId = $state("");
	let removing = $state<{ member: Member; preview: RemovalPreview } | null>(null);
	let deleting = $state<TeamDeletePreview | null>(null);
	let deleteTasks = $state<"archive" | "move">("archive");

	const byId = $derived(new Map(members.map((m) => [m.id, m])));
	const notInTeam = $derived(members.filter((m) => !team?.memberIds.includes(m.id)));

	async function load() {
		error = "";
		try {
			const [teams, all] = await Promise.all([
				api<Team[]>("GET", "/api/teams"),
				api<Member[]>("GET", "/api/members"),
			]);
			team = teams.find((t) => t.id === teamId) ?? null;
			members = all;
			if (!team) error = "Household not found.";
		} catch (e) {
			error = errorMessage(e);
		}
	}

	async function act(action: () => Promise<unknown>) {
		error = "";
		try {
			await action();
		} catch (e) {
			error = errorMessage(e);
		}
	}

	const rename = (event: SubmitEvent) => {
		event.preventDefault();
		error = checkText("Household name", name, LIMITS.teamName) ?? "";
		if (error) return;
		return act(async () => {
			team = await api<Team>("PATCH", `/api/teams/${teamId}`, { name });
			renaming = false;
		});
	};

	const add = () =>
		act(async () => {
			team = await api<Team>("PUT", `/api/teams/${teamId}/members/${addId}`);
			addId = "";
		});

	const startRemove = (member: Member) =>
		act(async () => {
			removing = {
				member,
				preview: await api<RemovalPreview>(
					"GET",
					`/api/teams/${teamId}/members/${member.id}/removal-preview`,
				),
			};
		});

	const confirmRemove = () =>
		act(async () => {
			team = await api<Team>("DELETE", `/api/teams/${teamId}/members/${removing!.member.id}`);
			removing = null;
		});

	const startDelete = () =>
		act(async () => {
			deleting = await api<TeamDeletePreview>("GET", `/api/teams/${teamId}/delete-preview`);
		});

	const confirmDelete = () =>
		act(async () => {
			await api("DELETE", `/api/teams/${teamId}?tasks=${deleteTasks}`);
			location.hash = href("settings");
		});

	$effect(() => {
		teamId;
		load();
	});
</script>

{#if !team || renaming}
	<PageHeader
		title={renaming ? "Rename household" : "Household"}
		back={{ href: href("settings"), label: "Settings" }}
	/>
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}

{#if team}
	{#if renaming}
		<form class="card" onsubmit={rename}>
			<label>Household name <input bind:value={name} maxlength={LIMITS.teamName} /></label>
			<div class="actions">
				<button type="submit">Save</button>
				<button type="button" class="ghost" onclick={() => (renaming = false)}>Cancel</button>
			</div>
		</form>
	{:else}
		<PageHeader title={team.name} back={{ href: href("settings"), label: "Settings" }}>
			{#snippet action()}
				{#if admin}<button
						class="secondary small"
						onclick={() => ((name = team!.name), (renaming = true))}
						><Icon name="edit" size={17} />Rename</button
					>{/if}
			{/snippet}
		</PageHeader>
	{/if}

	<section class="card">
		<h3>People in this household</h3>
		{#if team.memberIds.length === 0}
			<p class="muted">Nobody yet.{admin ? " Add family members below." : ""}</p>
		{:else}
			<ul class="list">
				{#each team.memberIds as id (id)}
					{@const member = byId.get(id)}
					<li>
						<span class="person">
							<Avatar {id} name={member?.displayName ?? "?"} size={32} />
							{member?.displayName ?? "Unknown"}
						</span>
						{#if admin && member}<button
								class="ghost small danger"
								onclick={() => startRemove(member)}>Remove</button
							>{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if removing}
			<div class="confirm">
				<p><strong>Remove {removing.member.displayName} from {team.name}?</strong></p>
				<p>They'll no longer see this household's tasks.</p>
				{#if removing.preview.tasks.length}
					<p>These tasks will change:</p>
					<ul>
						{#each removing.preview.tasks as task (task.id)}
							<li>
								{task.title}:
								{[task.asAssignee && "becomes unassigned", task.asWatcher && "they stop watching"]
									.filter(Boolean)
									.join(", ")}
								{#if task.remindersWiden}<em>(reminders will go to everyone in the household)</em
									>{/if}
							</li>
						{/each}
					</ul>
				{/if}
				<div class="actions">
					<button class="danger" onclick={confirmRemove}>Remove</button>
					<button class="ghost" onclick={() => (removing = null)}>Cancel</button>
				</div>
			</div>
		{/if}

		{#if admin && notInTeam.length}
			<div class="add">
				<select bind:value={addId} aria-label="Add a family member">
					<option value="">Add a family member…</option>
					{#each notInTeam as member (member.id)}<option value={member.id}
							>{member.displayName}</option
						>{/each}
				</select>
				<button class="secondary" onclick={add} disabled={!addId}>Add</button>
			</div>
		{/if}
	</section>

	{#if admin}
		<section class="card">
			<h3>Delete household</h3>
			{#if deleting}
				<p><strong>Delete {team.name}?</strong></p>
				{#if deleting.taskCount}
					<p>
						It has {deleting.taskCount} open task{deleting.taskCount > 1 ? "s" : ""}. What should
						happen to {deleting.taskCount > 1 ? "them" : "it"}?
					</p>
					<label class="check"
						><input type="radio" bind:group={deleteTasks} value="archive" /> Archive (keep the history)</label
					>
					<label class="check"
						><input type="radio" bind:group={deleteTasks} value="move" /> Move to the whole family</label
					>
				{/if}
				<div class="actions">
					<button class="danger" onclick={confirmDelete}>Delete household</button>
					<button class="ghost" onclick={() => (deleting = null)}>Cancel</button>
				</div>
			{:else}
				<p class="muted small">Its people stay in the family; only the household goes.</p>
				<button class="danger small" onclick={startDelete}
					><Icon name="trash" size={17} />Delete household…</button
				>
			{/if}
		</section>
	{/if}
{/if}

<style>
	.person {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.confirm {
		margin-top: var(--space);
		padding: var(--space);
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
	}
	.confirm ul {
		padding-left: 1.2em;
	}
	.add {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.add select {
		margin: 0;
	}
</style>
