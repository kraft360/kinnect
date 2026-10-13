<script lang="ts">
	import type { TaskState } from "../../shared/sync.ts";
	import type { MeResponse } from "../../shared/types.ts";
	import { href } from "../router.svelte.ts";
	import Icon, { type IconName } from "../components/Icon.svelte";
	import PageHeader from "../components/PageHeader.svelte";
	import ReminderWarnings from "../components/ReminderWarnings.svelte";
	import TaskRow from "../components/TaskRow.svelte";
	import {
		currentOccurrence,
		labelsInUse,
		live,
		matchesFilter,
		reminderWarnings,
		type TaskFilter,
	} from "../sync.svelte.ts";
	import OfflineBanner from "./OfflineBanner.svelte";

	let { me }: { me: MeResponse } = $props();

	let showArchived = $state(false);

	// Filters (FR-31), remembered on this device.
	const FILTER_KEY = "kinnect.taskFilter";
	const saved = (() => {
		try {
			return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as TaskFilter | null;
		} catch {
			return null;
		}
	})();
	let filter = $state<TaskFilter>({ who: "all", personId: "", teamId: "", label: "", ...saved });
	$effect(() => localStorage.setItem(FILTER_KEY, JSON.stringify(filter)));
	const filtered = $derived(
		filter.who !== "all" || filter.personId || filter.teamId || filter.label,
	);
	const labels = $derived(labelsInUse());

	const tasks = $derived(
		Object.values(live.tasks).filter(
			(t) => t.archived === showArchived && matchesFilter(t, filter, me.member.id),
		),
	);
	// Family-wide first, then each household (FR-31).
	const groups = $derived([
		{
			key: "family",
			name: "Whole family",
			teamId: null as string | null,
			tasks: tasks.filter((t) => t.teamId === null),
		},
		...live.teams.map((team) => ({
			key: team.id,
			name: team.name,
			teamId: team.id as string | null,
			tasks: tasks.filter((t) => t.teamId === team.id),
		})),
	]);
	const otherArchived = $derived(
		tasks.filter((t) => t.teamId !== null && !live.teams.some((team) => team.id === t.teamId)),
	);

	/** Missed first, then by when they're next due, then plain tasks (open before done, newest first). */
	function rank(task: TaskState): [number, number] {
		const occurrence = task.schedule ? currentOccurrence(task) : null;
		if (occurrence?.status === "missed") return [0, occurrence.dueAt];
		if (occurrence) return [1, occurrence.dueAt];
		if (task.schedule) return [2, 0];
		return task.doneAt === null ? [3, -task.updatedAt] : [4, -task.updatedAt];
	}
	const sorted = (list: TaskState[]) =>
		[...list].sort((a, b) => {
			const [ra, rb] = [rank(a), rank(b)];
			return ra[0] - rb[0] || ra[1] - rb[1];
		});
	const warnings = $derived(
		showArchived ? [] : reminderWarnings(tasks.filter((t) => t.assigneeId !== me.member.id)),
	);
	const clear = () => (filter = { who: "all", personId: "", teamId: "", label: "" });
</script>

{#snippet chipSelect(
	icon: IconName,
	key: "personId" | "teamId" | "label",
	label: string,
	options: { value: string; text: string }[],
)}
	<span class="chip-select" class:active={filter[key]}>
		<Icon name={icon} size={16} />
		<select bind:value={filter[key]} aria-label={label}>
			{#each options as option (option.value)}<option value={option.value}>{option.text}</option
				>{/each}
		</select>
		{#if filter[key]}
			<button
				class="clear"
				aria-label="Clear {label.toLowerCase()} filter"
				onclick={() => (filter[key] = "")}><Icon name="x" size={16} /></button
			>
		{:else}
			<Icon name="down" size={16} />
		{/if}
	</span>
{/snippet}

<OfflineBanner />

{#if showArchived}
	<PageHeader title="Archived tasks">
		{#snippet action()}<button class="ghost small" onclick={() => (showArchived = false)}
				><Icon name="back" size={18} />Tasks</button
			>{/snippet}
	</PageHeader>
{:else}
	<PageHeader title="Tasks">
		{#snippet action()}
			<div class="segmented" role="group" aria-label="Show">
				<button aria-pressed={filter.who === "mine"} onclick={() => (filter.who = "mine")}
					>Mine</button
				>
				<button aria-pressed={filter.who === "all"} onclick={() => (filter.who = "all")}>All</button
				>
			</div>
		{/snippet}
	</PageHeader>

	<div class="filters">
		{@render chipSelect("person", "personId", "Assigned to", [
			{ value: "", text: "Anyone" },
			...live.members.map((m) => ({ value: m.id, text: m.displayName })),
		])}
		{#if live.teams.length}
			{@render chipSelect("home", "teamId", "Household", [
				{ value: "", text: "All households" },
				{ value: "family", text: "Whole family" },
				...live.teams.map((t) => ({ value: t.id, text: t.name })),
			])}
		{/if}
		{#if labels.length || filter.label}
			{@render chipSelect("label", "label", "Label", [
				{ value: "", text: "Any label" },
				...labels.map((l) => ({ value: l.label, text: l.label })),
			])}
		{/if}
	</div>

	<ReminderWarnings {warnings} />
{/if}

{#if live.status === "connecting" && live.syncedVersion === null}
	<p class="muted">Loading…</p>
{:else}
	{#each groups as group (group.key)}
		{#if group.tasks.length || (!showArchived && !filtered && group.teamId !== null)}
			<h3 class="section-label">
				<span>{group.name}</span>
				{#if !showArchived && group.teamId}<a
						class="button ghost small"
						href={href("new-task", group.teamId)}><Icon name="plus" size={16} />Add</a
					>{/if}
			</h3>
			<section class="card rows">
				{#if group.tasks.length === 0}
					<p class="muted empty">No tasks yet.</p>
				{:else}
					<ul class="list">
						{#each sorted(group.tasks) as task (task.id)}<TaskRow
								{task}
								timeZone={me.organization.timezone}
								meId={me.member.id}
							/>{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{/each}
	{#if showArchived && otherArchived.length}
		<h3 class="section-label">Deleted households</h3>
		<section class="card rows">
			<ul class="list">
				{#each otherArchived as task (task.id)}<TaskRow
						{task}
						timeZone={me.organization.timezone}
						meId={me.member.id}
					/>{/each}
			</ul>
		</section>
	{/if}
	{#if showArchived && tasks.length === 0}<p class="card muted">Nothing archived.</p>{/if}
	{#if !showArchived && filtered && tasks.length === 0}
		<div class="card empty-state">
			<p class="muted">No tasks match these filters.</p>
			<button class="secondary small" onclick={clear}>Clear filters</button>
		</div>
	{/if}
	{#if !showArchived && !filtered && tasks.length === 0 && !live.teams.length}
		<div class="card empty-state">
			<p><strong>No tasks yet</strong></p>
			<p class="muted">Add the first one with the + button.</p>
		</div>
	{/if}
{/if}

{#if !showArchived}
	<p class="archived">
		<button class="ghost small" onclick={() => (showArchived = true)}
			><Icon name="archive" size={18} />Show archived</button
		>
	</p>
{/if}

<style>
	.segmented {
		display: flex;
		padding: 3px;
		border-radius: 999px;
		background: var(--surface-2);
	}
	.segmented button {
		min-height: 38px;
		padding: 0 16px;
		background: transparent;
		color: var(--muted);
		font-size: 0.92rem;
	}
	.segmented button[aria-pressed="true"] {
		background: var(--surface);
		color: var(--text);
		box-shadow: var(--shadow);
	}
	/* One row that scrolls sideways, edge to edge. */
	.filters {
		display: flex;
		gap: 8px;
		margin: 0 calc(var(--space) * -1) 8px;
		padding: 2px var(--space) 8px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.chip-select {
		position: relative;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 40px;
		max-width: 100%;
		padding: 0 6px 0 12px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--muted);
		font-size: 0.92rem;
	}
	.chip-select.active {
		background: var(--accent-soft);
		border-color: transparent;
		color: var(--on-accent-soft);
	}
	.chip-select select {
		appearance: none;
		width: auto;
		min-width: 0;
		min-height: 38px;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text);
		font-size: 0.92rem;
		font-weight: 600;
		text-overflow: ellipsis;
		box-shadow: none;
	}
	.chip-select.active select {
		color: var(--on-accent-soft);
	}
	.clear {
		min-height: 32px;
		width: 32px;
		padding: 0;
		background: transparent;
		color: inherit;
	}
	.rows {
		padding-top: 2px;
		padding-bottom: 2px;
	}
	.empty {
		margin: 12px 0;
	}
	.empty-state {
		text-align: center;
	}
	.archived {
		text-align: center;
		margin-top: 16px;
	}
</style>
